import { useFrontendTool } from "@copilotkit/react-core/v2";
import { ToolLine } from "@/components/channels/tool-line";
import { CommandOutput } from "@/components/computer/command-output";
import { ComputerView } from "@/components/computer/computer-view";
import { tryClient } from "@/lib/client";
import { noteBrowsed, recordActivity } from "@/lib/computers/activity";
import { type ControlState, readControl } from "@/lib/computers/control";
import {
  computerClickContract,
  computerKeyContract,
  computerListFilesContract,
  computerNavigateContract,
  computerReadContract,
  computerReadFileContract,
  computerRequestHelpContract,
  computerRequestSecretContract,
  computerRunCommandContract,
  computerScrollContract,
  computerSnapshotContract,
  computerTypeContract,
  computerWriteFileContract,
  reportRefusalContract,
} from "../../../../shared/computer-tool-contracts";
import { useActiveBotHolder } from "./active-bot";
import { reportComputerActivity } from "./computer-activity";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

/** What every computer call returns to the model: either the result, or a reason it did not happen. */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * Human-assistance wait window. Long enough for a user to return, finite so the run can unblock.
 */
const WAIT_FOR_PERSON_MS = 10 * 60_000;

/** How often the waiting handler asks whether the person has answered yet. */
const WAIT_POLL_MS = 1_000;

/** Hold the tool call open until the human control/secret prompt is answered, cancelled, or expires. */
async function waitForPerson(
  botId: string,
  done: (state: ControlState) => boolean,
  signal: AbortSignal | undefined,
  giveUpAfterMs = WAIT_FOR_PERSON_MS,
): Promise<"answered" | "gave up" | "cancelled"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (signal?.aborted) return "cancelled";
    const state = await readControl(botId).catch(() => null);
    if (state && done(state)) return "answered";
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}

/**
 * Exported for the test that covers what a Bot is told when a call is refused.
 *
 * The distinctions this draws from a status and a body decide the model's next step, and they are
 * drawn nowhere else, so they are worth pinning without standing up the tool registrations and the
 * runtime around them.
 */
export async function callComputer(
  botId: string,
  path: string,
  /*
   * A body, not a `RequestInit`. The client serialises it, so a caller that stringified first would
   * send a JSON string of a JSON string — which is what happened, briefly, when this moved over.
   */
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  reportComputerActivity(botId);
  let response: Response;
  try {
    response = await tryClient(`/api/computers/${botId}${path}`, {
      method: init?.method,
      body: init?.body,
      // Abort cancels the request and prevents later actions, but cannot undo browser work already executing.
      signal,
    });
  } catch (error) {
    // An abort is a stopped run, not a computer failure.
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "Stopped.", stopped: true };
    }
    return {
      ok: false,
      reason: "The assistant's computer could not be reached.",
    };
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    return {
      ok: false,
      reason: (body?.error as string) ?? "That did not work.",
      // Preserve refusal/stale-ref/control distinctions for the model's next step.
      ...(response.status === 403
        ? { refused: true, rule: body?.rule ?? null }
        : {}),
      ...(response.status === 409
        ? body?.humanHasControl === true
          ? { humanHasControl: true }
          : { staleRefs: true }
        : {}),
    };
  }

  return { ok: true, ...(body ?? {}) };
}

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  refused?: boolean;
  reason?: string;
  staleRefs?: boolean;
  elements?: unknown[];
  element?: { role?: string; name?: string };
  /** What a shell call reports back, so the line can show the output rather than only the command. */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The far side cut the output short, or stopped the command. */
  truncated?: boolean;
  timedOut?: boolean;
  /** A file write. The size, never what was written. */
  bytes?: number;
  /** A file read. Named `text` on the way back and `contents` on the way in. */
  text?: string;
  /** Where a navigation landed, which is what a finished turn's screen tile remembers. */
  url?: string;
  title?: string;
};

/**
 * What a call printed, as text a person can read.
 *
 * One helper because the three surfaces this feeds all want the same thing and shape it differently:
 * a command has `stdout` and `stderr`, a file read has `contents`, a listing has `entries`. A refusal
 * carries only its reason, and that is the most useful thing on the line.
 *
 * Never guesses. Something with none of those fields gives an empty string, and the pane says the
 * call printed nothing rather than inventing a summary.
 */
export function outputOf(result: ToolOutcome): string {
  if (result.refused === true || result.ok === false) {
    return typeof result.reason === "string" ? result.reason : "";
  }

  // `text`, which is what the read route answers with. Not `contents`: that is the name on the way
  // in, and reading it back gave an empty pane for a file the Bot had just read out loud.
  if (typeof result.text === "string") return result.text;

  if (Array.isArray(result.entries)) {
    return result.entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const { path, kind, bytes } = entry as Record<string, unknown>;
        const label = String(path ?? "");
        // A trailing slash for a folder, the way a terminal marks one, so a listing of a workspace
        // full of folders does not read as a list of extensionless files.
        if (kind === "folder") return `${label}/`;
        return typeof bytes === "number" ? `${label}  ${bytes} bytes` : label;
      })
      .join("\n");
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  // Both, in the order a terminal shows them, and labelled only when there is something on stderr:
  // most commands write nothing there and a permanent empty heading is noise.
  return stderr ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout;
}

/**
 * Parse the SDK-render result string so the transcript can distinguish success, refusal, and failure.
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    // Runtime stringifies thrown handlers as "Error: <message>".
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 */
function ActionLine({
  label,
  detail,
  running,
  refused,
  failed,
}: {
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <ToolLine
      detail={detail}
      failed={failed}
      label={label}
      refused={refused}
      running={running}
    />
  );
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

export function ComputerTools() {
  const bot = useActiveBotHolder();

  useFrontendTool({
    ...computerNavigateContract,
    handler: async (
      { url }: { url: string },
      // Context is optional in the SDK.
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const result = await callComputer(
        computerId,
        "/navigate",
        {
          method: "POST",
          /*
           * Which turn is asking, so the server can file the picture under it.
           *
           * The handler's context carries the tool call, which is worth saying because assuming it
           * did not is how the frame ended up keyed on the page instead: two visits to one address
           * then collided, and resolving that by letting the newer win made a past turn's picture
           * change under the person reading it.
           */
          body: { url, ...(toolCall?.id ? { toolCallId: toolCall.id } : {}) },
        },
        signal,
      );
      /*
       * This Bot has a page of its own now, so the pane may default to the screen.
       *
       * Until it does, the screen shows whatever the shared computer had open last, which may be
       * another Bot's page from an hour ago. Captioning that as this Bot's screen is confidently
       * wrong, and worse than showing nothing.
       */
      if (result.ok) noteBrowsed(computerId);
      return result.ok
        ? {
            ok: true,
            title: result.title,
            url: result.url,
            text: result.text,
            truncated: result.truncated,
          }
        : result;
    },
    render: ({ result, status, toolCallId }) => {
      /*
       * The page this turn left open, so reopening the conversation shows what it browsed rather
       * than what the Bot has open now. Only once the turn is finished: while it runs, the live
       * frames are its own.
       */
      /*
       * A RESULT IS WHAT MAKES A TURN OVER, not the status.
       *
       * A restored tool call arrives with its result already in hand and a status that is briefly
       * something other than complete, so keying on the status alone made every reopened turn look
       * like one still running: the tile polled the live screen, put today's page under yesterday's
       * answer, and only then restored the frame it should have shown from the start.
       */
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      const page =
        typeof outcome.url === "string"
          ? {
              url: outcome.url,
              ...(typeof outcome.title === "string"
                ? { title: outcome.title }
                : {}),
            }
          : undefined;
      return (
        <div className="my-2">
          <ComputerView
            computerId={bot.current}
            active={!finished}
            /*
             * FINISHED, NOT "GOT SOMEWHERE". The tile used to count a turn as history only once it
             * had a page, so a navigation that was refused, failed or stopped never settled: it kept
             * polling the live screen under a turn that was over, and offered control of it. Those
             * are the turns most worth freezing, because the thing on screen has nothing to do with
             * what the person is reading.
             */
            finished={finished}
            {...(page ? { page } : {})}
            {...(toolCallId ? { toolCallId } : {})}
          />
        </div>
      );
    },
  });

  useFrontendTool({
    ...computerReadContract,
    handler: async () => callComputer(bot.current, "/read"),
    render: () => null,
  });

  useFrontendTool({
    ...computerSnapshotContract,
    handler: async () =>
      callComputer(bot.current, "/snapshot", { method: "POST" }),
    // Snapshot renders a count only; navigate owns the screen view.
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const elements = Array.isArray(outcome.elements) ? outcome.elements : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="Read the page"
          detail={
            elements.length
              ? `${elements.length} thing${elements.length === 1 ? "" : "s"} it can act on`
              : undefined
          }
        />
      );
    },
  });

  useFrontendTool({
    ...computerTypeContract,
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/type",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Filled in"
        detail={
          // Never show typed values; identify only the target field.
          labelOf(result) ??
          (typeof args?.ref === "string" ? args.ref : undefined)
        }
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    ...computerClickContract,
    handler: async (
      input: { ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/click",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Clicked"
          detail={
            // Show refusal reason instead of an internal element ref.
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : (labelOf(result) ??
                (typeof args?.ref === "string" ? args.ref : undefined))
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...computerKeyContract,
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/key",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Pressed"
        detail={typeof args?.key === "string" ? args.key : undefined}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    ...computerRequestSecretContract,
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/secret",
        {
          method: "POST",
          body: input,
        },
        signal,
      );
      if (!asked.ok) return asked;

      // Completion is `secretWanted` clearing; the value never returns to the model.
      const outcome = await waitForPerson(
        botId,
        (state) => state.secretWanted === undefined,
        signal,
      );
      return {
        ok: true,
        result:
          outcome === "answered"
            ? `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`
            : outcome === "cancelled"
              ? "The request was cancelled."
              : `Nobody entered ${input.label}. Do not ask for it another way.`,
      };
    },
    // Rendered by ComputerView as a masked prompt.
    render: () => null,
  });

  /** Self-reported model declines: audit evidence, not an enforcement control. */
  useFrontendTool({
    ...reportRefusalContract,
    handler: async (
      input: { reason: string; request?: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      try {
        const response = await tryClient(
          `/api/agents/${encodeURIComponent(bot.current)}/declined`,
          { method: "POST", body: input, signal },
        );
        return response.ok
          ? "Recorded. Now tell the person what you decided and why."
          : "That could not be recorded. Tell the person what you decided anyway.";
      } catch {
        // Audit bookkeeping must not prevent the Bot from answering.
        return "That could not be recorded. Tell the person what you decided anyway.";
      }
    },
    render: () => null,
  });

  useFrontendTool({
    ...computerRequestHelpContract,
    handler: async (
      input: { reason: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/request",
        {
          method: "POST",
          body: input,
        },
        signal,
      );
      if (!asked.ok) return asked;

      // Resolved when the wheel is back with the Bot and no help request remains outstanding.
      const outcome = await waitForPerson(
        botId,
        (state) => state.holder === "bot" && !state.requested,
        signal,
      );
      return {
        ok: true,
        result:
          outcome === "answered"
            ? "The person has finished and handed control back. Take a fresh snapshot: the page may have changed while they were driving."
            : outcome === "cancelled"
              ? "The request was cancelled."
              : "Nobody took control. Say what you still need rather than trying to do it yourself.",
      };
    },
    // Rendered by ComputerView as the take-the-wheel prompt.
    render: () => null,
  });

  useFrontendTool({
    ...computerListFilesContract,
    handler: async (input: { path?: string }) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/list", {
        method: "POST",
        body: input ?? {},
      });
      recordActivity(computerId, {
        kind: "list_files",
        subject: input?.path ?? "the workspace",
        output: outputOf(result),
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label="Listed files"
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? String(outcome.reason ?? "")
              : entries.length
                ? `${entries.length} item${entries.length === 1 ? "" : "s"} in the workspace`
                : "nothing saved yet"
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...computerReadFileContract,
    handler: async (input: { path: string }) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/read", {
        method: "POST",
        body: input,
      });
      recordActivity(computerId, {
        kind: "read_file",
        subject: input.path,
        output: outputOf(result),
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label="Read file"
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...computerRunCommandContract,
    handler: async (
      input: { command: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const computerId = bot.current;
      const result = await callComputer(
        computerId,
        "/exec",
        { method: "POST", body: input },
        signal,
      );
      /*
       * Recorded here rather than in `render`, which runs again on every re-render and would append
       * the same command each time. This is the only place that runs once per call and has both the
       * command and what it printed.
       */
      recordActivity(computerId, {
        kind: "command",
        subject: input.command,
        output: outputOf(result),
        ...(typeof result.exitCode === "number"
          ? { exitCode: result.exitCode }
          : {}),
        ...(result.refused === true ? { refused: true } : {}),
        ...(result.truncated === true ? { truncated: true } : {}),
        ...(result.timedOut === true ? { timedOut: true } : {}),
      });
      return result;
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      /*
       * The command on the line, its output behind the chevron.
       *
       * The line stays one line, because a transcript of a Bot working through twenty commands is
       * unreadable if each one dumps a screenful. But the output has to be reachable: this ran on a
       * machine holding somebody's logins, and "take the model's word for what it printed" is not an
       * answer. The pane beside the screen shows the same thing without expanding anything.
       */
      const printed = outputOf(outcome as ToolOutcome);
      const exit = typeof outcome.exitCode === "number" ? outcome.exitCode : 0;
      return (
        <ToolLine
          running={status !== "complete"}
          label="Ran a command"
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.command === "string"
                ? args.command
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome) || exit !== 0}
        >
          {status === "complete" ? (
            <CommandOutput
              output={printed}
              exitCode={exit}
              truncated={outcome.truncated === true}
              timedOut={outcome.timedOut === true}
            />
          ) : null}
        </ToolLine>
      );
    },
  });

  useFrontendTool({
    ...computerWriteFileContract,
    handler: async (input: {
      path: string;
      contents: string;
      append?: boolean;
    }) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/write", {
        method: "POST",
        body: input,
      });
      /*
       * The path and the size, never the contents. A Bot may well be saving something it was told in
       * confidence, and the write route declines to echo it back for exactly that reason; putting it
       * in a pane would undo that.
       */
      recordActivity(computerId, {
        kind: "write_file",
        subject: input.path,
        output:
          result.refused === true
            ? outputOf(result)
            : typeof result.bytes === "number"
              ? `${result.bytes} bytes${input.append === true ? ", appended" : ""}`
              : "",
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={args?.append === true ? "Added to file" : "Saved file"}
          // Show the path, never file contents.
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useFrontendTool({
    ...computerScrollContract,
    handler: async (
      input: { deltaY?: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/scroll",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label="Scrolled"
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  return null;
}
