/**
 * One turn of a Bot, run on the server with nobody watching.
 *
 * A scheduled run is an unattended run. Nobody is looking at the screen, nobody can take the wheel,
 * and nobody can answer a question. That is exactly the condition a boundary exists for, so the
 * thing this module must not do is invent a quieter path to the computer for work nobody is
 * supervising.
 *
 * It does not. The browser normally executes the computer tools, see
 * app/src/lib/copilot/computer-tools.tsx, but that is a rendering arrangement and never was where
 * anything was decided: the tool handler there is a `fetch` to this server, and the policy decision,
 * the audit row and the action itself have always happened here, in the gateway. So an unattended
 * run does not need a weaker path. It needs the same one, and it gets it: every tool call below goes
 * through {@link ComputerGateway}, is judged by the same rules an attended click is judged by, and
 * leaves the same rows behind. The only difference visible to a rule is `run.unattended`, which is
 * there so a deployment can be stricter about work nobody is watching rather than more permissive.
 *
 * What is deliberately absent is the human. `computer_request_help`, `computer_request_secret` and
 * the take-the-wheel handover are not offered, because they are all requests for a person who is
 * not there, and a tool that waits ten minutes for an answer nobody will give turns an unattended
 * run into an unattended hang. A model that reaches for one is told plainly that it is unavailable
 * rather than having the call quietly dropped: a tool call that vanishes leaves a model repeating
 * itself, and a model that is told is a model that can say what it could not finish.
 */
import type { AbstractAgent, BaseEvent, Message, Tool } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import { ActionRefusedError } from "../computer/gateway";

/**
 * How many times the model may act before the run is stopped.
 *
 * A cap rather than a timeout, because the thing that runs away is a loop, not a long call: a model
 * that keeps re-snapshotting a page that never changes will do it as fast as the computer answers.
 * Twenty is generous for the work a routine actually describes and small enough that a stuck run
 * costs minutes rather than a night.
 */
export const DEFAULT_MAX_TURNS = 20;

/**
 * How long the whole run may take, however many turns that is.
 *
 * The turn cap above stops a loop; this stops a stall, and they are different failures. A cap counts
 * things that finish, and the shape that has to be survived here is a call that never finishes at
 * all: a remote AG-UI Bot whose connection drops without the stream erroring, or any agent that
 * hands back an observable which neither completes nor fails. `collectOneTurn` waits on `complete` or
 * `error`, so a stream that does neither leaves it waiting forever, and forever is not an
 * exaggeration — there is no socket timeout underneath it and nothing else watching.
 *
 * What that costs without a deadline is not one lost run. The run row stays `running`, which holds
 * the one-live-run index, and the routine never fires again by any route: the tick skips it, Run now
 * answers "already running", every delivery answers the same, and the only cure in the product is
 * deleting the routine and its whole history. A deadline turns all of that into an ordinary failed
 * run that says what happened.
 *
 * Fifteen minutes is generous for the work a routine describes and short enough that a stuck run
 * costs a quarter of an hour rather than a night. A routine that genuinely needs longer is a routine
 * that should be split, because nothing is watching this one.
 */
export const DEFAULT_RUN_DEADLINE_MS = 15 * 60_000;

export type RoutineRunRequest = {
  /** Which Bot. Resolved to an agent by the caller's loader, so visibility rules still apply. */
  agentId: string;
  /** What the routine says, put to the Bot exactly as a person would have typed it. */
  prompt: string;
  /**
   * The name this run's conversation is given.
   *
   * Passed to the agent and written on the run row, so one run's turns are told apart from another's
   * by anything that sees both. It is a name and not a stored transcript: nothing here persists the
   * conversation. See the note on `routine_runs.thread_id`.
   */
  threadId: string;
  /** Who it runs as. The gateway records this and the boundary can read it. */
  actor: ActionActor;
};

export type RoutineRunOutcome = {
  /** What the Bot said last, which is what the run history shows. */
  summary: string;
  /** How many times the model was asked, for the operator wondering why a run took a while. */
  turns: number;
  /** True when the cap stopped it rather than the model finishing. */
  stoppedAtCap: boolean;
};

export type RoutineRunnerOptions = {
  /** The only path to an acting call, unattended or not. */
  gateway: ComputerGateway;
  /**
   * Resolve the Bot to an agent that can be run.
   *
   * A function rather than a map, because who may run which Bot is decided per person and a routine
   * belongs to one. Handing the runner a prebuilt map would mean a routine kept working after its
   * owner lost access to the Bot, which is a quiet way to leave a deleted colleague's work running.
   */
  resolveAgent: (request: {
    agentId: string;
    actor: ActionActor;
  }) => Promise<AbstractAgent | null>;
  maxTurns?: number;
  /** The wall clock a run is held to. See {@link DEFAULT_RUN_DEADLINE_MS}. */
  deadlineMs?: number;
};

export type RoutineRunner = {
  run: (request: RoutineRunRequest) => Promise<RoutineRunOutcome>;
};

/** A run that never started, as opposed to one that started and went wrong. Told apart in the trail. */
export class RoutineBotUnavailableError extends Error {
  constructor(agentId: string) {
    super(
      `${agentId} is not a Bot this routine's owner can run. It may have been deleted or made private.`,
    );
    this.name = "RoutineBotUnavailableError";
  }
}

/**
 * A run that was still going when its time ran out.
 *
 * Its own class rather than a plain Error, following computer/client.ts: this is not the Bot failing
 * at the work, it is the work not ending, and somebody reading a run history needs to be able to
 * tell a Bot that could not do the job from one that never came back.
 */
export class RoutineRunDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(
      `The run was still going after ${Math.round(deadlineMs / 60_000)} minutes and was stopped. The Bot may have been waiting on something that never answered.`,
    );
    this.name = "RoutineRunDeadlineError";
  }
}

export function createRoutineRunner(
  options: RoutineRunnerOptions,
): RoutineRunner {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS;

  return {
    run: async (request) => {
      /*
       * One deadline for the run, spent across however many turns it takes, rather than one per
       * turn. A per-turn timeout would let twenty turns of fourteen minutes each add up to nearly
       * five hours while every individual turn looked well behaved, which is precisely the run
       * nobody is watching.
       */
      const expiresAt = Date.now() + deadlineMs;
      const agent = await options.resolveAgent({
        agentId: request.agentId,
        actor: request.actor,
      });
      if (!agent) throw new RoutineBotUnavailableError(request.agentId);

      const messages: Message[] = [
        {
          id: `routine-prompt-${crypto.randomUUID()}`,
          role: "user",
          content: request.prompt,
        },
      ];

      let said = "";
      for (let turn = 1; turn <= maxTurns; turn += 1) {
        // Raised rather than returned. A run that ran out of time did not finish the work, and a
        // summary is the shape of an answer; the scheduler writes this as a failed run, which
        // releases the routine's one-live-run claim and says why on the page.
        if (Date.now() >= expiresAt)
          throw new RoutineRunDeadlineError(deadlineMs);

        const spoke = await collectOneTurn(agent, {
          threadId: request.threadId,
          messages,
          // What is left of the run's own clock, so a turn that never settles cannot outlive it.
          remainingMs: expiresAt - Date.now(),
          deadlineMs,
        });
        if (spoke.text.trim()) said = spoke.text.trim();

        messages.push({
          id: spoke.messageId,
          role: "assistant",
          ...(spoke.text ? { content: spoke.text } : {}),
          ...(spoke.toolCalls.length
            ? {
                toolCalls: spoke.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.args },
                })),
              }
            : {}),
        });

        if (spoke.toolCalls.length === 0) {
          return { summary: said, turns: turn, stoppedAtCap: false };
        }

        for (const call of spoke.toolCalls) {
          messages.push({
            id: `routine-tool-${call.id}`,
            role: "tool",
            toolCallId: call.id,
            content: await executeToolCall(options.gateway, request, call),
          });
        }
      }

      return {
        // Said out loud in the summary rather than only in a field, because the run history is read
        // as prose and "it stopped because it ran out of turns" is the part a person needs to see.
        summary: said
          ? `${said}\n\n(The run was stopped after ${maxTurns} turns.)`
          : `The run was stopped after ${maxTurns} turns without the Bot finishing.`,
        turns: maxTurns,
        stoppedAtCap: true,
      };
    },
  };
}

/** One tool call the model made, reassembled from the streamed events. */
type PendingToolCall = { id: string; name: string; args: string };

type TurnResult = {
  messageId: string;
  text: string;
  toolCalls: PendingToolCall[];
};

/**
 * Drive one `run()` to completion and reduce the event stream back into a message.
 *
 * The stream is the protocol's own shape, deltas of text and deltas of tool arguments, and putting
 * it back together is what the browser SDK does for an attended run. Doing it here rather than
 * reaching for a client helper keeps the runner testable against a fake agent that emits events,
 * which is the only way the interesting cases, an unknown tool, a refused action, a model that says
 * nothing at all, can be written down as tests rather than acted out against a live model.
 *
 * BOTH SPELLINGS OF THE STREAM ARE HANDLED, and that is not defensiveness. The protocol carries text
 * either as START/CONTENT/END or as a single CHUNK, and tool calls the same way, and which one
 * arrives depends on the agent: the built-in Bot emits chunks, and a remote AG-UI endpoint on some
 * other framework may well emit the split form. Reading only one of them produces a run that
 * completes, records success, and has an empty summary, which is the worst shape a failure can take
 * because nothing anywhere says it went wrong.
 *
 * A `RUN_ERROR` is raised as an exception rather than returned as text. It means the model or its
 * transport failed, which is a failed run and not a turn with a disappointing answer, and the two
 * have to be distinguishable in the run history or a person cannot tell a broken Bot from a quiet one.
 */
async function collectOneTurn(
  agent: AbstractAgent,
  input: {
    threadId: string;
    messages: Message[];
    /** What is left of the run's deadline. */
    remainingMs: number;
    /** The whole run's allowance, for the sentence a person reads. */
    deadlineMs: number;
  },
): Promise<TurnResult> {
  const messageId = `routine-said-${crypto.randomUUID()}`;
  let text = "";
  const calls = new Map<string, PendingToolCall>();
  const order: string[] = [];
  let failure: string | null = null;

  /** Start a call, or return the one already open. Both spellings arrive here. */
  const beginCall = (id: string, name: string) => {
    const existing = calls.get(id);
    if (existing) {
      // A chunk may repeat the name without meaning a second call. Kept, rather than blanked by a
      // later chunk that carries only a delta.
      if (name) existing.name = name;
      return existing;
    }
    const call: PendingToolCall = { id, name, args: "" };
    calls.set(id, call);
    order.push(id);
    return call;
  };

  await new Promise<void>((resolve, reject) => {
    let subscription: { unsubscribe: () => void } | undefined;
    /*
     * The turn's share of the run's clock, and the only thing that ends a stream which does neither.
     *
     * Held here rather than around the whole loop because this is where the waiting happens: a
     * promise that settles on `complete` or `error` and nothing else settles never, and every layer
     * above it is then waiting on a promise, not on a socket. Cleared on both ways out so a finished
     * turn does not leave a timer keeping anything alive.
     */
    const expiry = setTimeout(
      () => {
        // Safe to reach for the subscription from in here, unlike the error path below: this callback
        // cannot run in the same tick that created it, so the binding exists by the time it does. The
        // stream is dropped rather than left running, because an agent that is still emitting into a
        // turn nobody is waiting for is an agent still spending somebody's model budget.
        subscription?.unsubscribe();
        reject(new RoutineRunDeadlineError(input.deadlineMs));
      },
      Math.max(0, input.remainingMs),
    );

    const events = agent.run({
      threadId: input.threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: input.messages,
      tools: UNATTENDED_TOOLS,
      context: [],
      forwardedProps: {},
    });

    subscription = events.subscribe({
      next: (event: BaseEvent) => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_CONTENT:
            text += (event as unknown as { delta: string }).delta;
            break;
          case EventType.TEXT_MESSAGE_CHUNK:
            text += (event as unknown as { delta?: string }).delta ?? "";
            break;
          case EventType.TOOL_CALL_START: {
            const started = event as unknown as {
              toolCallId: string;
              toolCallName: string;
            };
            beginCall(started.toolCallId, started.toolCallName);
            break;
          }
          case EventType.TOOL_CALL_ARGS: {
            const arrived = event as unknown as {
              toolCallId: string;
              delta: string;
            };
            const call = calls.get(arrived.toolCallId);
            if (call) call.args += arrived.delta;
            break;
          }
          case EventType.TOOL_CALL_CHUNK: {
            /*
             * Every field is optional in a chunk. An id-less chunk is a continuation of the call
             * already open, which is why the last one started is remembered: dropping those deltas
             * would leave a tool call with truncated JSON, and truncated JSON is a call the runner
             * refuses for a reason that would look like the model's fault.
             */
            const chunk = event as unknown as {
              toolCallId?: string;
              toolCallName?: string;
              delta?: string;
            };
            const id = chunk.toolCallId ?? order.at(-1);
            if (!id) break;
            const call = beginCall(id, chunk.toolCallName ?? "");
            call.args += chunk.delta ?? "";
            break;
          }
          case EventType.RUN_ERROR:
            failure = (event as unknown as { message: string }).message;
            break;
          default:
            break;
        }
      },
      // Nothing is unsubscribed here on purpose. An observable that errors is already finished, and
      // reaching for the subscription from inside the callback that created it is a reference to a
      // binding that does not exist yet when the failure is synchronous, which is exactly the case a
      // broken agent produces.
      error: (caught: unknown) => {
        clearTimeout(expiry);
        reject(caught instanceof Error ? caught : new Error(String(caught)));
      },
      complete: () => {
        clearTimeout(expiry);
        resolve();
      },
    });
  });

  if (failure) throw new Error(failure);

  return {
    messageId,
    text,
    toolCalls: order
      .map((id) => calls.get(id))
      .filter((call): call is PendingToolCall => call !== undefined),
  };
}

/**
 * Carry out one tool call, and always answer.
 *
 * Every outcome comes back as text for the model, including the failures, because a tool result is
 * the only channel a model has for finding out what happened. A refusal in particular has to arrive
 * as words: a Bot told "this deployment's policy does not allow that" can say so in its summary and
 * stop, whereas a Bot handed an empty result will try the same thing a different way, which is the
 * behaviour a boundary is meant to prevent rather than provoke.
 */
async function executeToolCall(
  gateway: ComputerGateway,
  request: RoutineRunRequest,
  call: PendingToolCall,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.args.trim() ? JSON.parse(call.args) : {};
    args =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return answer({
      ok: false,
      reason: `The arguments to ${call.name} were not valid JSON, so nothing was done.`,
    });
  }

  const botId = request.agentId;
  const actor = request.actor;

  try {
    switch (call.name) {
      case "computer_navigate": {
        const url = text(args.url);
        if (!url)
          return answer({ ok: false, reason: "A web address is required." });
        return answer({
          ok: true,
          ...(await gateway.navigate(botId, botId, actor, url)),
        });
      }
      case "computer_read":
        return answer({ ok: true, ...(await gateway.read(botId)) });
      case "computer_snapshot":
        return answer({ ok: true, ...(await gateway.snapshot(botId)) });
      case "computer_click": {
        const target = actionTarget(args);
        if (!target) return answer(NEEDS_A_SNAPSHOT);
        return answer({
          ok: true,
          ...(await gateway.click(botId, botId, actor, target)),
        });
      }
      case "computer_type": {
        const target = actionTarget(args);
        if (!target) return answer(NEEDS_A_SNAPSHOT);
        if (typeof args.text !== "string") {
          return answer({
            ok: false,
            reason: "The text to enter is required.",
          });
        }
        return answer({
          ok: true,
          ...(await gateway.type(botId, botId, actor, {
            ...target,
            text: args.text,
            submit: args.submit === true,
          })),
        });
      }
      case "computer_key": {
        const key = text(args.key);
        if (!key) {
          return answer({
            ok: false,
            reason: "A key name is required, such as Enter or Tab.",
          });
        }
        const target = actionTarget(args);
        return answer({
          ok: true,
          ...(await gateway.key(botId, botId, actor, {
            key,
            ...(target ?? {}),
          })),
        });
      }
      case "computer_scroll":
        return answer({
          ok: true,
          ...(await gateway.scroll(botId, botId, actor, {
            ...(typeof args.deltaY === "number" ? { deltaY: args.deltaY } : {}),
          })),
        });
      case "computer_list_files":
        return answer({
          ok: true,
          ...(await gateway.listFiles(botId, botId, actor, {
            ...(text(args.path) ? { path: text(args.path) as string } : {}),
          })),
        });
      case "computer_read_file": {
        const path = text(args.path);
        if (!path)
          return answer({ ok: false, reason: "A file path is required." });
        return answer({
          ok: true,
          ...(await gateway.readFile(botId, botId, actor, { path })),
        });
      }
      case "computer_write_file": {
        const path = text(args.path);
        if (!path)
          return answer({ ok: false, reason: "A file path is required." });
        if (typeof args.contents !== "string") {
          return answer({
            ok: false,
            reason: "The contents to write are required.",
          });
        }
        return answer({
          ok: true,
          ...(await gateway.writeFile(botId, botId, actor, {
            path,
            contents: args.contents,
            append: args.append === true,
          })),
        });
      }
      default:
        // A chunked stream can in principle deliver a call whose name never arrived. It is still
        // answered, with a name a sentence can be built around, because the rule is that no tool
        // call goes unanswered rather than that no NAMED tool call does.
        return answer(unavailable(call.name || "That tool"));
    }
  } catch (error) {
    if (error instanceof ActionRefusedError) {
      // The rule travels with the refusal, exactly as it does to the browser, so a Bot writing a
      // summary can say which boundary stopped it rather than reporting a vague failure.
      return answer({
        ok: false,
        refused: true,
        reason: error.message,
        rule: error.rule,
      });
    }
    return answer({
      ok: false,
      reason: error instanceof Error ? error.message : "That did not work.",
    });
  }
}

/**
 * What the model is told about a tool this run does not have.
 *
 * Named in the message, and the reason is given. A model that asked for help and is told only "tool
 * not found" concludes it made a mistake and tries a synonym; one that is told nobody is watching
 * concludes correctly that it should write down what it could not do and stop.
 */
function unavailable(toolName: string) {
  return {
    ok: false,
    reason:
      `${toolName} is not available in an unattended run. This run has no person watching it, ` +
      "so nothing that needs one can happen: say in your answer what you could not do and why, " +
      "rather than looking for another way round it.",
  };
}

const NEEDS_A_SNAPSHOT = {
  ok: false,
  reason:
    "A ref and the snapshotId it came from are both required. Take a snapshot first.",
};

/** The model reads JSON, the same shape the browser hands it, so a Bot behaves the same either way. */
function answer(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function actionTarget(
  args: Record<string, unknown>,
): { ref: string; snapshotId: number } | undefined {
  if (typeof args.ref !== "string" || !args.ref) return undefined;
  if (typeof args.snapshotId !== "number") return undefined;
  return { ref: args.ref, snapshotId: args.snapshotId };
}

/**
 * The tools an unattended run offers, described the way the attended ones are.
 *
 * The descriptions are close copies of the browser registrations on purpose. They are what the model
 * reads, and a Bot that behaves differently at eight in the morning than it does when somebody is
 * talking to it is a Bot nobody can reason about. Where they differ they say so: there is nobody to
 * ask, so the wording never suggests asking.
 */
export const UNATTENDED_TOOLS: Tool[] = [
  {
    name: "computer_navigate",
    description:
      "Open a web page on your own computer. Returns the page title and its readable text, so " +
      "answer from what comes back. Nobody is watching this run, so never tell anyone to go and look.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full web address to open, including https://",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after an " +
      "action that changes the page, to find out what it now says.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description:
            "Ref of the element to click, from your most recent snapshot",
        },
        snapshotId: {
          type: "number",
          description: "The snapshotId that ref came from",
        },
      },
      required: ["ref", "snapshotId"],
    },
  },
  {
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Ref of the field, from your most recent snapshot",
        },
        snapshotId: {
          type: "number",
          description: "The snapshotId that ref came from",
        },
        text: { type: "string", description: "The text to enter" },
        submit: {
          type: "boolean",
          description:
            "Press Enter after typing, to submit a single-field form",
        },
      },
      required: ["ref", "snapshotId", "text"],
    },
  },
  {
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key name, such as Enter, Tab or Escape",
        },
        ref: {
          type: "string",
          description: "Optional ref to press the key on",
        },
        snapshotId: {
          type: "number",
          description:
            "The snapshotId the ref came from, required if ref is given",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "computer_scroll",
    description:
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
    parameters: {
      type: "object",
      properties: {
        deltaY: {
          type: "number",
          description: "Pixels to scroll; positive is down. Defaults to 600.",
        },
      },
    },
  },
  {
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you need a file whose exact name you are not sure of. Never guess a filename.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional folder to list. Omit for the whole workspace.",
        },
      },
    },
  },
  {
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between runs, so use this to " +
      "pick up what a previous run of this routine left for you.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to your workspace, such as notes.md",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only. This is how a run leaves something behind " +
      "for the next one, since nobody is reading this conversation as it happens.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path relative to your workspace, such as reports/august.csv",
        },
        contents: { type: "string", description: "The text to save" },
        append: {
          type: "boolean",
          description: "Add to the end of the file instead of replacing it",
        },
      },
      required: ["path", "contents"],
    },
  },
];
