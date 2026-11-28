import {
  type ReactFrontendTool,
  useCopilotKit,
  useFrontendTool as useSDKFrontendTool,
} from "@copilotkit/react-core/v2";
import { withFinishedAt } from "@openbot/shared/computer-control";
import { COMPUTER_START_WAIT_MS } from "@openbot/shared/computer-start";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { runComputerStep } from "@/lib/api/generated/approvals/approvals";
import type { ComputerStepOutcome } from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { threadAsksEveryStepQueryOptions } from "@/lib/approvals";
import { ClientError } from "@/lib/client";
import { failedComputerCall } from "@/lib/computers/call";
import { useBotOfCall } from "./active-bot";
import {
  frontendApprovalSnapshot,
  WAITING_FOR_PERSON,
} from "./approval-context";
import { heldByServer } from "./server-owned-interrupts";
import { inStepOrder } from "./tool-steps";

type RenderProps = { toolCallId: string; [key: string]: unknown };

const needsConversation = (outcome: unknown) =>
  !!outcome &&
  typeof outcome === "object" &&
  (outcome as { needsConversation?: unknown }).needsConversation === true;

/** The gate ran the step and the computer answered that it is still starting, having done nothing. */
const stillStarting = (step: ComputerStepOutcome) =>
  step.outcome === "done" &&
  "result" in step &&
  !!step.result &&
  typeof step.result === "object" &&
  (step.result as { starting?: unknown }).starting === true;

/** The pause before asking the gate again about a computer still starting, as `callComputer` pauses. */
const START_ASK_AGAIN_MS = 2_000;

/** Resolves after `ms`, or at once when `signal` is aborted. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** What the Bot is told when a step in a conversation that asks first has nowhere to ask. */
const NOT_ASKED =
  "Not done: this conversation asks before every step, and this step couldn't be asked about here.";

const writes = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_run_command",
  "computer_write_file",
  // Not a change, and still through the gate: the server needs the conversation to put the file in.
  SEND_FILE_TOOL,
]);

/**
 * Whether the run asking is in a conversation that asks before every step, which a task's started
 * from a check-in does: then a look at a page goes through the gate too, since a look sent straight
 * to the computer carries no conversation to ask in.
 *
 * ASKED OF THE SERVER, FOR THIS THREAD, and decided by the rule its gate applies. Never inferred
 * from the conversation list this app happens to hold: a task opened by a link, or one past the
 * list's first page, is not in it. Anything but a plain no (the check failed, or has no answer)
 * sends the look through the gate, where the server decides; that costs a larger request, never a
 * look nobody was asked about.
 */
async function asksEveryStep(
  queries: QueryClient,
  threadId: string | undefined,
): Promise<boolean> {
  if (!threadId) return false;
  try {
    return (
      (await queries.fetchQuery({
        ...threadAsksEveryStepQueryOptions(threadId),
        retry: false,
      })) !== false
    );
  } catch {
    return true;
  }
}

/**
 * Route computer changes through the server's durable approval gate, and draw a pending decision
 * inline where the action would have been.
 *
 * EVERY CHANGE GOES THROUGH THE GATE, not only when "Ask before making changes" is on. The server
 * decides, and it can ask for reasons the browser cannot see: a team rule, a safety requirement, the
 * auto-review model. It used to read the person's switch here, and the SDK registers a tool's
 * handler once and never again (its registration effect does not depend on the handler), so the
 * handler kept the switch as it was on first render, usually still loading. Every change then went
 * straight to the computer outside any run, and the gate could only answer "this action needs an
 * authenticated run". Nothing in this handler may depend on render-time state for that reason.
 *
 * A LOOK GOES STRAIGHT TO THE COMPUTER, AND COMES BACK THROUGH THE GATE WHEN A RULE ASKS ABOUT IT. A
 * navigation or a snapshot is usually allowed, and sending each one with the whole conversation would
 * be paid on every step of every page. A rule can still ask about one ("ask before opening pages"),
 * and that call arrives with no conversation to ask in, so the computer answers `needsConversation`
 * having done nothing. It is sent again here through the gate, where the person is asked; before
 * this, the Bot was handed the refusal and could only apologise for a card nobody was shown. In a
 * task's own conversation every look goes through the gate first, since a task asks before each one
 * (`asksEveryStep`, answered by the server for the thread).
 */
export function useFrontendTool<T extends Record<string, unknown>>(
  tool: ReactFrontendTool<T>,
) {
  const { copilotkit } = useCopilotKit();
  // Stable for the provider's life, so the SDK's once-registered handler may keep it.
  const queryClient = useQueryClient();
  const botOf = useBotOfCall();
  const render = tool.render;
  useSDKFrontendTool({
    ...tool,
    // Every computer tool, not only changes: a look a rule asks about waits on the same card.
    ...(tool.name.startsWith("computer_")
      ? {
          // A component, so the approval card can use hooks; the SDK keeps this function forever.
          render: (props: RenderProps) => {
            const Original = render as
              | ((props: RenderProps) => ReactNode)
              | undefined;
            return (
              <InlineApproval
                toolCallId={props.toolCallId}
                fallback={Original ? <Original {...props} /> : null}
              />
            );
          },
        }
      : {}),
    handler: tool.handler
      ? async (args, context) => {
          /*
           * A call the server holds is the server's: its run stopped on the server's own wait for
           * the person, and the server carries the conversation on once they have done their part.
           * Acted on here as well, a sign-in opened a second form. It waits, as a held step does.
           */
          if (heldByServer(context.agent, context.toolCall?.id))
            return WAITING_FOR_PERSON;
          /*
           * A computer action waits for the ones asked for before it in its step, and is not
           * taken after one that failed (`inStepOrder`), whether it goes to the gate or straight
           * to the computer.
           */
          if (!tool.name.startsWith("computer_")) return gated(args, context);
          // When it finished, kept in the answer for Activity (`withFinishedAt`), whichever way it ran.
          return withFinishedAt(
            await inStepOrder(
              {
                computerId: botOf(context.agent),
                messages: context.agent?.messages,
                toolCallId: context.toolCall?.id,
              },
              () => gated(args, context),
            ),
          );
        }
      : undefined,
  });

  /** The action itself: straight to the computer, or through the server's gate. */
  async function gated(
    args: T,
    context: Parameters<NonNullable<ReactFrontendTool<T>["handler"]>>[1],
  ): Promise<unknown> {
    let direct: unknown;
    const everyStep = await asksEveryStep(queryClient, context.agent?.threadId);
    if (!writes.has(tool.name) && !everyStep) {
      direct = await tool.handler?.(args, context);
      if (!needsConversation(direct)) return direct;
    }
    let snapshot: ReturnType<typeof frontendApprovalSnapshot>;
    try {
      snapshot = frontendApprovalSnapshot(context);
    } catch {
      /*
       * A surface with no observed conversation. The server still gates the action; it can
       * run it when nothing asks, and says why when something does. A look already went.
       * Not in a conversation that asks before every step: sent without its conversation,
       * the server could not tell, so the step is not taken at all.
       */
      if (everyStep) return { ok: false, reason: NOT_ASKED };
      return direct ?? tool.handler?.(args, context);
    }
    let step: ComputerStepOutcome;
    /*
     * ASKED AGAIN WHILE THE COMPUTER IS STILL STARTING, as a direct computer call is (`callComputer`),
     * until COMPUTER_START_WAIT_MS has gone. One step is answered inside what a request may wait, which
     * is less than a cold computer can take to come up, and its answer then says nothing was done, so
     * asking again cannot do it twice. Every change goes this way, a command among them: answered
     * "still starting", the Bot was told to try again, and the step's card said the computer was
     * starting where the command and what it printed should have been.
     */
    const startedAt = Date.now();
    for (;;) {
      try {
        // The gate of the Bot whose run this is, which the person may have navigated away from.
        step = await runComputerStep(
          organizationId(),
          "me",
          { botId: botOf(context.agent), conversation: snapshot },
          { "Idempotency-Key": idempotencyKey() },
          { signal: context.signal, fallback: "That did not work." },
        );
      } catch (error) {
        // The same two answers callComputer gives when the request itself does not complete.
        if (error instanceof DOMException && error.name === "AbortError")
          return { ok: false, reason: "Stopped.", stopped: true };
        // Answered, not thrown: a thrown handler ends the Bot's turn with nothing said (see
        // failedComputerCall), where a failed result lets it snapshot again or try another way.
        if (error instanceof ClientError)
          return failedComputerCall(error.status, { error: error.message });
        return {
          ok: false,
          reason: "The assistant's computer could not be reached.",
        };
      }
      /*
       * A STEP THE SERVER IS RUNNING ALREADY IS NOT RUN HERE. The server runs a Bot's computer steps
       * itself and runs each once, whoever asks; one it has started is `taken`, and is asked about
       * again, with the same step, until its run answers. Its answer is this step's (below).
       */
      if (step.outcome === "taken" && step.running) {
        await pause(START_ASK_AGAIN_MS, context.signal);
        if (context.signal?.aborted)
          return { ok: false, reason: "Stopped.", stopped: true };
        continue;
      }
      if (!stillStarting(step)) break;
      const left = COMPUTER_START_WAIT_MS - (Date.now() - startedAt);
      if (left <= 0) break;
      await pause(Math.min(START_ASK_AGAIN_MS, left), context.signal);
      if (context.signal?.aborted)
        return { ok: false, reason: "Stopped.", stopped: true };
    }
    // Already run by the server: what that run answered is this step's answer, and nothing runs again.
    if (step.outcome === "taken")
      return step.result !== undefined
        ? step.result
        : failedComputerCall(200, {
            error: "The computer action returned no result.",
          });
    if (step.outcome === "waiting") {
      if (!context.agent)
        throw new Error("The interrupted conversation is unavailable.");
      // Stop signals the SDK to discard this handler's unfinished result. The server owns
      // resume: the decision executes the action once and continues this conversation.
      copilotkit.stopAgent({ agent: context.agent });
      // Draw the card now rather than on the inbox's next poll.
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return WAITING_FOR_PERSON;
    }
    // The computer is held for a person: told to the Bot as the refusal it has always been.
    if (step.outcome === "held") {
      const { outcome: _held, ...held } = step;
      return failedComputerCall(409, held);
    }
    if (!("result" in step))
      return failedComputerCall(200, {
        error: "The computer action returned no result.",
      });
    return step.result;
  }
}
