import {
  type ReactFrontendTool,
  useCopilotKit,
  useFrontendTool as useSDKFrontendTool,
} from "@copilotkit/react-core/v2";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { threadAsksEveryStepQueryOptions } from "@/lib/approvals";
import { tryClient } from "@/lib/client";
import { failedComputerCall } from "@/lib/computers/call";
import { useBotOfCall } from "./active-bot";
import { frontendApprovalSnapshot } from "./approval-context";

type RenderProps = { toolCallId: string; [key: string]: unknown };

const needsConversation = (outcome: unknown) =>
  !!outcome &&
  typeof outcome === "object" &&
  (outcome as { needsConversation?: unknown }).needsConversation === true;

/** What the Bot is told when a step in a conversation that asks first has nowhere to ask. */
const NOT_ASKED =
  "Not done: this conversation asks before every step, and this step couldn't be asked about here.";

const writes = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_run_command",
  "computer_write_file",
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
          let direct: unknown;
          const everyStep = await asksEveryStep(
            queryClient,
            context.agent?.threadId,
          );
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
          let response: Response;
          try {
            // The gate of the Bot whose run this is, which the person may have navigated away from.
            response = await tryClient(
              `/api/approvals/computer/${encodeURIComponent(botOf(context.agent))}`,
              { method: "POST", body: snapshot, signal: context.signal },
            );
          } catch (error) {
            // The same two answers callComputer gives when the request itself does not complete.
            if (error instanceof DOMException && error.name === "AbortError")
              return { ok: false, reason: "Stopped.", stopped: true };
            return {
              ok: false,
              reason: "The assistant's computer could not be reached.",
            };
          }
          const payload: unknown = await response.json().catch(() => null);
          if (response.status === 202) {
            if (!context.agent)
              throw new Error("The interrupted conversation is unavailable.");
            // Stop signals the SDK to discard this handler's unfinished result. The server owns
            // resume: the decision executes the action once and continues this conversation.
            copilotkit.stopAgent({ agent: context.agent });
            // Draw the card now rather than on the inbox's next poll.
            void queryClient.invalidateQueries({ queryKey: ["approvals"] });
            return { waiting: true };
          }
          // Answered, not thrown: a thrown handler ends the Bot's turn with nothing said (see
          // failedComputerCall), where a failed result lets it snapshot again or try another way.
          if (!response.ok)
            return failedComputerCall(
              response.status,
              payload && typeof payload === "object"
                ? (payload as Record<string, unknown>)
                : null,
            );
          if (!payload || typeof payload !== "object" || !("result" in payload))
            return failedComputerCall(response.status, {
              error: "The computer action returned no result.",
            });
          return payload.result;
        }
      : undefined,
  });
}
