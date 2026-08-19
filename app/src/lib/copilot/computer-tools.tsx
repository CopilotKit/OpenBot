import { useFrontendTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ApprovalRequest } from "@/components/channels/approval-request";
import { ToolLine } from "@/components/channels/tool-line";
import { ComputerView } from "@/components/computer/computer-view";
import {
  type ControlState,
  readControl,
} from "@/components/computer/take-the-wheel";
import { closeQuestion, openQuestion, waitForApproval } from "@/lib/approvals";
import { useActiveBotHolder } from "./active-bot";
import { reportComputerActivity } from "./computer-activity";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

/** What every computer call returns to the model: either the result, or a reason it did not happen. */
type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * What the SDK hands a running tool call, as much of it as this file needs.
 *
 * Passed around whole rather than unpicked into an abort signal, because the id matters as much as
 * the abort does: it is what lets a question about this call be drawn on this call's line and
 * nowhere else. Optional throughout, because the SDK's context argument is optional and a handler
 * that destructures it unconditionally throws on any call that omits it.
 */
type ToolCallContext = { signal?: AbortSignal; toolCall?: { id?: string } };

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
 * The same request, carrying an answer.
 *
 * Rebuilt rather than mutated, because every acting route is a POST of one JSON object and the
 * approval is one more field on it. Sending the identical arguments matters: the server binds an
 * approval to a fingerprint of the action, so a retry that differed in any way it hashes would be
 * refused as a different action, which is exactly what that binding is for.
 */
function withApproval(
  init: RequestInit | undefined,
  approvalId: string,
): RequestInit {
  const sent =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  return {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sent, approvalId }),
  };
}

/**
 * One computer call, including the pause where a person is asked about it.
 *
 * The waiting lives here rather than in each tool's handler so that a tool cannot be added without
 * it: an acting route that met an ask rule and got back a bare failure would report to the model
 * that the action was impossible, when in fact nobody had been asked yet.
 */
async function callComputer(
  botId: string,
  path: string,
  init?: RequestInit,
  call: ToolCallContext = {},
): Promise<ToolOutcome> {
  const signal = call.signal;
  const outcome = await sendToComputer(botId, path, init, signal);
  if (outcome.awaitingApproval !== true) return outcome;

  const approvalId = String(outcome.approvalId ?? "");
  // Put in front of the person on this call's own line rather than left to be found. The id is what
  // ties the card to the action it is about; see lib/approvals.ts for why anything looser gets it
  // wrong.
  const toolCallId = call.toolCall?.id ?? "";
  openQuestion(toolCallId, {
    approvalId,
    botId,
    question: String(outcome.question ?? outcome.reason ?? ""),
    rule: typeof outcome.rule === "string" ? outcome.rule : null,
  });
  try {
    const answer = await waitForApproval(botId, approvalId, signal);
    if (answer === "granted") {
      // Sent once, not through this function again. A second ask on the retry would mean the approval
      // did not fit the action, and looping on that would hold the turn open until the deadline instead
      // of telling the model something it can act on.
      return sendToComputer(
        botId,
        path,
        withApproval(init, approvalId),
        signal,
      );
    }
    if (answer === "cancelled") {
      return { ok: false, reason: "Stopped.", stopped: true };
    }
    return answer === "declined"
      ? { ok: false, refused: true, reason: "A person declined that." }
      : {
          ok: false,
          reason:
            "Nobody answered the request to allow that, so it did not happen. Say what you were " +
            "waiting for rather than trying another way round it.",
        };
  } finally {
    // However the wait ended, nothing should still be offering buttons for it. A run that was
    // stopped leaves its question open on the server for the rest of its ten minutes, and a card
    // that outlived its own call would be collecting consent nobody is waiting for.
    closeQuestion(toolCallId);
  }
}

async function sendToComputer(
  botId: string,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  reportComputerActivity(botId);
  let response: Response;
  try {
    response = await fetch(`/api/computers/${botId}${path}`, {
      credentials: "include",
      // Abort cancels the request and prevents later actions, but cannot undo browser work already executing.
      ...(signal ? { signal } : {}),
      ...init,
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
    // Read before anything else a 409 can mean. The other two, stale refs and a person holding the
    // wheel, are conditions the model reacts to; this one it must not see at all, because the caller
    // above is going to wait and then send the very same request again.
    if (response.status === 409 && body?.awaitingApproval === true) {
      return {
        ok: false,
        awaitingApproval: true,
        approvalId: body.approvalId ?? "",
        question: body.question ?? "",
        rule: body.rule ?? null,
        reason: (body.error as string) ?? "Somebody is being asked about that.",
      };
    }
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
};

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
 *
 * While the action is still running it also carries the place a question about it appears. The card
 * belongs on the line for the action it is about, in sequence, rather than somewhere else on the
 * screen: a person deciding whether to allow a click wants to see what the Bot did to get there.
 */
function ActionLine({
  toolCallId,
  label,
  detail,
  running,
  refused,
  failed,
}: {
  /**
   * Which call this line is reporting.
   *
   * The card shows a question only when this exact call raised one, so a line for an action nobody
   * was asked about stays a line. Passing the Bot instead would draw whatever that Bot happened to
   * be waiting on, which on a second turn is somebody else's abandoned question.
   */
  toolCallId?: string;
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <>
      <ApprovalRequest toolCallId={toolCallId} />
      <ToolLine
        detail={detail}
        failed={failed}
        label={label}
        refused={refused}
        running={running}
      />
    </>
  );
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

export function ComputerTools() {
  const bot = useActiveBotHolder();

  useFrontendTool({
    name: "computer_navigate",
    description:
      "Open a web page on your own computer so the person can watch. Use this when asked to look " +
      "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
      "from what comes back rather than telling the person to go and look.",
    parameters: z.object({
      url: z.string().describe("Full web address to open, including https://"),
    }),
    handler: async ({ url }: { url: string }, call: ToolCallContext = {}) => {
      const result = await callComputer(
        bot.current,
        "/navigate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        },
        call,
      );
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
    render: ({ status, toolCallId }) => (
      <div className="my-2">
        {/*
         * Above the screen rather than through ActionLine, because opening a page draws the live
         * view instead of a line. A question about where the Bot is about to go still belongs
         * beside it.
         */}
        <ApprovalRequest toolCallId={toolCallId} />
        <ComputerView computerId={bot.current} active={status !== "complete"} />
      </div>
    ),
  });

  useFrontendTool({
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after you " +
      "click something that changes the page, such as submitting a form, to find out what it now says.",
    parameters: z.object({}),
    handler: async () => callComputer(bot.current, "/read"),
    render: () => null,
  });

  useFrontendTool({
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs.",
    parameters: z.object({}),
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
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards.",
    parameters: z.object({
      ref: z
        .string()
        .describe("Ref of the field, from your most recent snapshot"),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
      text: z.string().describe("The text to enter"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing, to submit a single-field form"),
    }),
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/type",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => (
      <ActionLine
        toolCallId={toolCallId}
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
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from.",
    parameters: z.object({
      ref: z
        .string()
        .describe(
          "Ref of the element to click, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { ref: string; snapshotId: number },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/click",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          toolCallId={toolCallId}
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
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: z.object({
      key: z.string().describe("Key name, such as Enter, Tab or Escape"),
      ref: z.string().optional().describe("Optional ref to press the key on"),
      snapshotId: z
        .number()
        .optional()
        .describe("The snapshotId the ref came from, required if ref is given"),
    }),
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/key",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => (
      <ActionLine
        toolCallId={toolCallId}
        running={status !== "complete"}
        label="Pressed"
        detail={typeof args?.key === "string" ? args.key : undefined}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useFrontendTool({
    name: "computer_request_secret",
    description:
      "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
      "Focus the field first with computer_click, then call this with the ref of that field and a " +
      "short label for what you need. They type it into a masked box that goes straight to the page. " +
      "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
      "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
      "if the form needs submitting, do that yourself afterwards with computer_click.",
    parameters: z.object({
      label: z
        .string()
        .describe(
          "What you need, in a few words, e.g. 'the code sent to your phone'",
        ),
      ref: z
        .string()
        .describe(
          "Ref of the field it goes in, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      call: ToolCallContext = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/secret",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      );
      if (!asked.ok) return asked;

      // Completion is `secretWanted` clearing; the value never returns to the model.
      const outcome = await waitForPerson(
        botId,
        (state) => state.secretWanted === undefined,
        call.signal,
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
    name: "report_refusal",
    description:
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
      "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
      "addition to telling the person. It changes nothing about your answer; it exists so an " +
      "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
      "not do something, only when you chose not to.",
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    handler: async (
      input: { reason: string; request?: string },
      call: ToolCallContext = {},
    ) => {
      try {
        const response = await fetch(
          `/api/agents/${encodeURIComponent(bot.current)}/declined`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
            ...(call.signal ? { signal: call.signal } : {}),
          },
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
    name: "computer_request_help",
    description:
      "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
      "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
      "will drive the browser themselves and hand it back, and you carry on in the same session. " +
      "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you.",
    parameters: z.object({
      reason: z
        .string()
        .describe(
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
        ),
    }),
    handler: async (input: { reason: string }, call: ToolCallContext = {}) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/request",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      );
      if (!asked.ok) return asked;

      // Resolved when the wheel is back with the Bot and no help request remains outstanding.
      const outcome = await waitForPerson(
        botId,
        (state) => state.holder === "bot" && !state.requested,
        call.signal,
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
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
      "are not sure of. Never guess a filename.",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional folder to list. Omit for the whole workspace."),
    }),
    handler: async (input: { path?: string }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/files/list",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input ?? {}),
        },
        call,
      ),
    render: ({ result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          toolCallId={toolCallId}
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
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
      "this to pick up notes you made before.",
    parameters: z.object({
      path: z
        .string()
        .describe("Path relative to your workspace, such as notes.md"),
    }),
    handler: async (input: { path: string }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/files/read",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          toolCallId={toolCallId}
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
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only.",
    parameters: z.object({
      path: z
        .string()
        .describe(
          "Path relative to your workspace, such as reports/august.csv",
        ),
      contents: z.string().describe("The text to save"),
      append: z
        .boolean()
        .optional()
        .describe("Add to the end of the file instead of replacing it"),
    }),
    handler: async (
      input: {
        path: string;
        contents: string;
        append?: boolean;
      },
      call: ToolCallContext = {},
    ) =>
      callComputer(
        bot.current,
        "/files/write",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ args, result, status, toolCallId }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          toolCallId={toolCallId}
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
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: z.object({
      deltaY: z
        .number()
        .optional()
        .describe("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    handler: async (input: { deltaY?: number }, call: ToolCallContext = {}) =>
      callComputer(
        bot.current,
        "/scroll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        call,
      ),
    render: ({ result, status, toolCallId }) => (
      <ActionLine
        toolCallId={toolCallId}
        running={status !== "complete"}
        label="Scrolled"
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  return null;
}
