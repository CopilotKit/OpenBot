/** @jsxImportSource @copilotkit/channels */
import { defineChannelComponent } from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import { z } from "zod";
import type { SlackApprovalAuthorization } from "./approval-authorizer";
import type {
  ApprovalDecisionStore,
  ApprovalPresentation,
} from "./approval-store";
import {
  maybeCurrentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "./execution-context";
import type {
  LinkedSlackIngress,
  SlackIngressRegistry,
} from "./ingress-registry";

type ApprovalDependencies = {
  store: ApprovalDecisionStore;
  authorize(input: {
    userId: string;
    presentation: ApprovalPresentation;
    liveIdentity: LinkedSlackIngress | null;
  }): Promise<boolean | SlackApprovalAuthorization>;
  now(): number;
  retentionMs: number;
};

let approvalDependencies: ApprovalDependencies | undefined;
let approvalInteractionBridge:
  | Pick<SlackIngressRegistry, "takeInteraction">
  | undefined;
let approvalExecutionBridge:
  | {
      run<T>(
        conversationKey: string,
        execution: SlackExecution,
        work: () => Promise<T>,
      ): Promise<T>;
    }
  | undefined;

/** Connect the channel's live identifyUser handoff to durable approval actions. */
export function configureApprovalInteractionBridge(
  bridge: Pick<SlackIngressRegistry, "takeInteraction">,
): void {
  approvalInteractionBridge = bridge;
}

/** Carry private execution across the deferred Channels resume boundary. */
export function configureApprovalExecutionBridge(
  bridge: NonNullable<typeof approvalExecutionBridge>,
): void {
  approvalExecutionBridge = bridge;
}

/** Wire the durable decision store before registering ApprovalCard with a Channel runtime. */
export function configureApprovalDecisionStore(
  store: ApprovalDecisionStore,
  options: Partial<Omit<ApprovalDependencies, "store">> = {},
): void {
  approvalDependencies = {
    store,
    authorize: options.authorize ?? (async () => false),
    now: options.now ?? Date.now,
    // Channels keeps actions for seven days by default. Keep the authorization row one day longer
    // so cleanup can never outpace the continuation it protects.
    retentionMs: options.retentionMs ?? 8 * 24 * 60 * 60_000,
  };
}

const approvalAction = z
  .object({
    presentationId: z.string().uuid(),
    approved: z.boolean(),
  })
  .strict();

/*
 * Channels 0.9 persists each non-undefined button actionValue in its ActionRegistry and replaces
 * the provider callback value with that stored value on hot and cold dispatch. Initial buttons use
 * an opaque presentation UUID plus the decision; cold renders use null, never undefined, so the
 * provider callback is never trusted as a fallback.
 */

async function claimAndResume(
  value: unknown,
  actionId: string,
  userId: string | null,
  providerActorId: string | null,
  platform: string,
  conversationKey: string | null,
  initialExecution: SlackExecution | null,
  resume: (decision: { approved: boolean }) => Promise<unknown>,
): Promise<void> {
  const dependencies = approvalDependencies;
  if (!dependencies) {
    throw new Error("ApprovalCard requires a durable approval decision store.");
  }
  if (!userId || !providerActorId || platform !== "slack" || !conversationKey) {
    throw new Error("This approval interaction could not be authorized.");
  }
  const decision = approvalAction.parse(value);
  const presentation = await dependencies.store.get(decision.presentationId);
  if (!presentation || presentation.conversationKey !== conversationKey) {
    throw new Error("This approval interaction could not be authorized.");
  }
  const liveIdentity =
    approvalInteractionBridge?.takeInteraction({
      provider: "slack",
      providerActorId,
      applicationUserId: userId,
    }) ?? null;
  const authorization = await dependencies.authorize({
    userId,
    presentation,
    liveIdentity,
  });
  if (!authorization) {
    throw new Error("This approval interaction could not be authorized.");
  }
  const claimed = await dependencies.store.begin({
    ...decision,
    actionId,
    decidedByUserId: userId,
  });
  if (claimed === "rejected") return;
  const execution = approvalExecution(
    authorization,
    presentation,
    initialExecution,
    userId,
  );
  if (execution) {
    const work = () => resume({ approved: decision.approved });
    await (approvalExecutionBridge
      ? approvalExecutionBridge.run(conversationKey, execution, work)
      : runWithSlackExecution(execution, work));
  } else {
    // Non-OpenBot Channels may use the component with a boolean authorizer and an agent that does
    // not require Slack execution facts. OpenBot's authorizer always returns the complete subject.
    await resume({ approved: decision.approved });
  }
  await dependencies.store.complete(decision.presentationId, actionId);
}

function approvalExecution(
  authorization: true | SlackApprovalAuthorization,
  presentation: ApprovalPresentation,
  initial: SlackExecution | null,
  userId: string,
): SlackExecution | null {
  if (authorization !== true) {
    return {
      ...authorization,
      channelsThreadId: presentation.channelsThreadId,
      channelsConversationKey: presentation.conversationKey,
      messageText: "",
      agentId: presentation.agentId,
    };
  }
  if (!initial || initial.actor.id !== userId) return null;
  return { ...initial };
}

function threadConversationKey(thread: unknown): string | null {
  if (!thread || typeof thread !== "object") return null;
  const value = (thread as { conversationKey?: unknown }).conversationKey;
  return typeof value === "string" && value ? value : null;
}

export const ApprovalCard = defineChannelComponent({
  name: "approval_card",
  description:
    "Ask the person to approve or reject a consequential action before continuing.",
  parameters: z.object({
    question: z.string().min(1).describe("The decision the person must make"),
  }),
  async render({ question }) {
    const execution = maybeCurrentSlackExecution();
    const subject =
      execution?.channelsThreadId &&
      execution.channelsConversationKey &&
      execution.agentId
        ? {
            channelsThreadId: execution.channelsThreadId,
            conversationKey: execution.channelsConversationKey,
            agentId: execution.agentId,
            createdByUserId: execution.actor.id,
          }
        : null;
    const presentation = subject
      ? { presentationId: crypto.randomUUID(), ...subject }
      : null;
    if (presentation) {
      const dependencies = approvalDependencies;
      if (!dependencies) {
        throw new Error(
          "ApprovalCard requires a durable approval decision store.",
        );
      }
      const now = dependencies.now();
      await dependencies.store.cleanup(
        new Date(now - dependencies.retentionMs),
      );
      await dependencies.store.present(presentation);
    }
    return (
      <Message fallbackText={question}>
        <Section>{question}</Section>
        <Actions>
          <Button
            key="approval-approve"
            onClick={async ({ action, thread, user, actor, platform }) => {
              await claimAndResume(
                action.value,
                action.id,
                user?.id ?? null,
                actor?.kind === "human" ? actor.id : null,
                platform ?? "",
                threadConversationKey(thread),
                execution,
                (decision) => thread.resume(decision),
              );
            }}
            style="primary"
            value={
              presentation
                ? {
                    presentationId: presentation.presentationId,
                    approved: true,
                  }
                : null
            }
          >
            Approve
          </Button>
          <Button
            key="approval-reject"
            onClick={async ({ action, thread, user, actor, platform }) => {
              await claimAndResume(
                action.value,
                action.id,
                user?.id ?? null,
                actor?.kind === "human" ? actor.id : null,
                platform ?? "",
                threadConversationKey(thread),
                execution,
                (decision) => thread.resume(decision),
              );
            }}
            value={
              presentation
                ? {
                    presentationId: presentation.presentationId,
                    approved: false,
                  }
                : null
            }
          >
            Reject
          </Button>
        </Actions>
      </Message>
    );
  },
});
