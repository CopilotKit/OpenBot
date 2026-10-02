import {
  type ReactFrontendTool,
  useCopilotKit,
  useFrontendTool as useSDKFrontendTool,
} from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { tryClient } from "@/lib/client";
import { useActiveBotHolder } from "./active-bot";
import { frontendApprovalSnapshot } from "./approval-context";

type RenderProps = { toolCallId: string; [key: string]: unknown };

const writes = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_run_command",
  "computer_write_file",
]);

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
 */
export function useFrontendTool<T extends Record<string, unknown>>(
  tool: ReactFrontendTool<T>,
) {
  const { copilotkit } = useCopilotKit();
  // Stable for the provider's life, so the SDK's once-registered handler may keep it.
  const queryClient = useQueryClient();
  const bot = useActiveBotHolder();
  const render = tool.render;
  useSDKFrontendTool({
    ...tool,
    ...(writes.has(tool.name)
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
          if (!writes.has(tool.name)) return tool.handler?.(args, context);
          let snapshot: ReturnType<typeof frontendApprovalSnapshot>;
          try {
            snapshot = frontendApprovalSnapshot(context);
          } catch {
            // A surface with no observed conversation. The server still gates the action; it can
            // run it when nothing asks, and says why when something does.
            return tool.handler?.(args, context);
          }
          const response = await tryClient(
            `/api/approvals/computer/${encodeURIComponent(bot.current)}`,
            { method: "POST", body: snapshot, signal: context.signal },
          );
          const payload: unknown = await response.json();
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
          if (!response.ok)
            throw new Error(
              payload &&
                typeof payload === "object" &&
                "error" in payload &&
                typeof payload.error === "string"
                ? payload.error
                : "The computer action could not be approved.",
            );
          if (!payload || typeof payload !== "object" || !("result" in payload))
            throw new Error("The computer action returned no result.");
          return payload.result;
        }
      : undefined,
  });
}
