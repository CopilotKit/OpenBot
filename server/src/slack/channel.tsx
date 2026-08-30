/** @jsxImportSource @copilotkit/channels */
import {
  type Channel,
  type ChannelIdentityContext,
  createChannel,
} from "@copilotkit/channels";
import { Actions, Button, Message, Section } from "@copilotkit/channels/ui";
import type { ComputerGateway } from "../computer/gateway";
import type { SlackAssistanceOptions } from "./assistance";
import {
  OpenBotChannelAgent,
  type OpenBotChannelAgentDependencies,
} from "./channel-agent";
import {
  ApprovalCard,
  configureApprovalExecutionBridge,
  configureApprovalInteractionBridge,
} from "./components";
import {
  createSlackComputerTools,
  type SlackComputerTool,
} from "./computer-tools";
import {
  currentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "./execution-context";
import type {
  SlackIdentityLinker,
  SlackIdentityResult,
} from "./identity-linker";
import {
  providerThreadIdFromIdentity,
  SlackIngressRegistry,
} from "./ingress-registry";
import { normalizeSlackTenantContext } from "./tenant-context";
import {
  defaultSlackTurnFailureLogger,
  runSlackPhase,
  type SlackTurnFailureLogger,
} from "./turn-phase";

export type OpenBotSlackChannelDependencies = {
  identityLinker: Pick<SlackIdentityLinker, "resolve">;
  appUrl?: string;
  configuredTenantId?: string;
  agentDeps: OpenBotChannelAgentDependencies;
  ingressRegistry?: SlackIngressRegistry;
  computerGateway?: ComputerGateway;
  assistance?: SlackAssistanceOptions;
  logTurnFailure?: SlackTurnFailureLogger;
  prepareExecution?: SlackExecutionPreparer;
};

function linkCard(linkUrl: string) {
  return (
    <Message fallbackText={`Link your OpenBot account: ${linkUrl}`}>
      <Section>
        Link your Slack identity to OpenBot before asking a coworker to run.
      </Section>
      <Actions>
        <Button url={linkUrl} style="primary">
          Link OpenBot account
        </Button>
      </Actions>
    </Message>
  );
}

function transcriptCard(transcriptUrl: string) {
  return (
    <Message
      fallbackText={`Open this conversation in OpenBot: ${transcriptUrl}`}
    >
      <Section>
        View this canonical Slack conversation on the OpenBot domain. Continue
        chatting here in Slack.
      </Section>
      <Actions>
        <Button url={transcriptUrl}>Open in OpenBot</Button>
      </Actions>
    </Message>
  );
}

function transcriptUrl(appUrl: string, channelsThreadId: string): string {
  return new URL(
    `/slack/thread/${encodeURIComponent(channelsThreadId)}`,
    appUrl,
  ).toString();
}

function eventId(context: ChannelIdentityContext): string | undefined {
  const id = context.event.id;
  return typeof id === "string" ? id : undefined;
}

function isNewMessage(message: { operation?: { kind?: string } }): boolean {
  return message.operation?.kind === "created";
}

function validRememberedPrincipal(
  remembered: Parameters<SlackIngressRegistry["remember"]>[1],
  message: Parameters<Parameters<Channel["onMention"]>[0]>[0]["message"],
): boolean {
  const { identityContext: context, identityResult: result } = remembered;
  const identity = result.identity;
  return (
    context.provider === "slack" &&
    context.actor.kind === "human" &&
    context.actor.id === message.actor.id &&
    identity.provider === "slack" &&
    identity.providerTenantId === context.tenant.id &&
    identity.providerUserId === context.actor.id &&
    (result.kind === "unlinked" ||
      (!!message.user &&
        result.user.id === message.user.id &&
        result.actor.id === message.user.id))
  );
}

function executionFor(
  identityContext: ChannelIdentityContext,
  result: Extract<SlackIdentityResult, { kind: "linked" }>,
  conversationKey: string,
  messageText: string,
): SlackExecution {
  return {
    actor: result.actor,
    applicationUser: result.user,
    provider: "slack",
    providerTenantId: identityContext.tenant.id,
    providerConversationId: identityContext.conversation.id,
    providerThreadId: providerThreadIdFromIdentity(identityContext),
    channelsConversationKey: conversationKey,
    messageText,
  };
}

type SlackExecutionPreparer = typeof executionFor;

/** Declare the managed OpenBot Slack Channel. The Copilot runtime attaches its adapter. */
export function createOpenBotSlackChannel(
  deps: OpenBotSlackChannelDependencies,
): Channel {
  const ingress = deps.ingressRegistry ?? new SlackIngressRegistry();
  const logTurnFailure = deps.logTurnFailure ?? defaultSlackTurnFailureLogger;
  const prepareExecution = deps.prepareExecution ?? executionFor;
  const pendingExecutions = new Map<string, SlackExecution[]>();
  function pendingExecutionFor(
    conversationKey: string,
  ): SlackExecution | undefined {
    return pendingExecutions.get(conversationKey)?.[0];
  }
  async function runWithPendingExecution<T>(
    conversationKey: string,
    execution: SlackExecution,
    work: () => Promise<T>,
  ): Promise<T> {
    return runWithSlackExecution(execution, async () => {
      const protectedExecution = currentSlackExecution();
      const queue = pendingExecutions.get(conversationKey) ?? [];
      queue.push(protectedExecution);
      pendingExecutions.set(conversationKey, queue);
      try {
        return await work();
      } finally {
        const remaining = pendingExecutions.get(conversationKey);
        const index = remaining?.indexOf(protectedExecution) ?? -1;
        if (remaining && index >= 0) remaining.splice(index, 1);
        if (remaining?.length === 0) pendingExecutions.delete(conversationKey);
      }
    });
  }
  configureApprovalInteractionBridge(ingress);
  configureApprovalExecutionBridge({ run: runWithPendingExecution });
  const tools: SlackComputerTool[] = deps.computerGateway
    ? createSlackComputerTools(
        deps.computerGateway,
        deps.assistance,
        pendingExecutionFor,
      )
    : [];
  const channel = createChannel({
    name: "openbot",
    identifyUser: async (context) => {
      if (context.actor.kind !== "human") return null;
      const { identityContext, identityResult } = await runSlackPhase(
        "identity.resolve",
        async () => {
          const identityContext = normalizeSlackTenantContext(
            context,
            deps.configuredTenantId,
          );
          const identityResult =
            await deps.identityLinker.resolve(identityContext);
          return { identityContext, identityResult };
        },
        logTurnFailure,
      );
      await runSlackPhase(
        "ingress.remember",
        () =>
          ingress.remember(eventId(identityContext), {
            identityContext,
            identityResult,
          }),
        logTurnFailure,
      );
      return identityResult.kind === "linked" ? identityResult.user : null;
    },
    // Channels caches an agent by conversation, so execution lookup must happen on every run. The
    // queue bridges detached managed-delivery operations where AsyncLocalStorage is unavailable.
    agent: (threadId) =>
      new OpenBotChannelAgent(threadId, deps.agentDeps, undefined, () =>
        pendingExecutionFor(threadId),
      ),
    tools,
    components: [ApprovalCard],
    // Managed Slack native streams can strand the final reply when a task chunk
    // opens the stream before any assistant text. Composer status remains active.
    showToolStatus: false,
    store: { concurrency: "serial", actionRetentionMs: 10 * 60_000 },
  });

  async function runLinked({
    message,
    thread,
    subscribe,
  }: {
    message: Parameters<Parameters<Channel["onMention"]>[0]>[0]["message"];
    thread: Parameters<Parameters<Channel["onMention"]>[0]>[0]["thread"];
    subscribe: boolean;
  }): Promise<void> {
    if (message.actor.kind !== "human" || !isNewMessage(message)) return;
    const remembered = await runSlackPhase(
      "ingress.take",
      () =>
        ingress.take(message.eventId, {
          provider: "slack",
          providerActorId: message.actor.id,
          applicationUserId: message.user?.id ?? null,
        }),
      logTurnFailure,
    );
    await runSlackPhase(
      "identity.validate",
      () => {
        if (!remembered || !validRememberedPrincipal(remembered, message)) {
          throw new Error(
            "Managed Slack ingress identity is no longer available.",
          );
        }
      },
      logTurnFailure,
    );
    if (!remembered) return;
    const identityResult = remembered.identityResult;
    if (identityResult.kind === "unlinked") {
      await runSlackPhase(
        "link_card.post",
        () => thread.post(linkCard(identityResult.linkUrl)),
        logTurnFailure,
      );
      return;
    }
    if (!message.user) {
      await runSlackPhase(
        "identity.validate",
        () => {
          throw new Error(
            "Managed Slack ingress identity did not match its user.",
          );
        },
        logTurnFailure,
      );
      return;
    }
    if (subscribe) {
      await runSlackPhase(
        "thread.subscribe",
        () => thread.subscribe(),
        logTurnFailure,
      );
    }
    const execution = await runSlackPhase(
      "execution.prepare",
      () =>
        prepareExecution(
          remembered.identityContext,
          identityResult,
          thread.conversationKey,
          message.text,
        ),
      logTurnFailure,
    );
    await runSlackPhase(
      "agent.run",
      () =>
        runWithPendingExecution(thread.conversationKey, execution, () =>
          thread.runAgent(
            message.contentParts?.length
              ? { prompt: message.contentParts }
              : undefined,
          ),
        ),
      logTurnFailure,
    );
    const appUrl = deps.appUrl;
    if (subscribe && appUrl) {
      try {
        await runSlackPhase(
          "transcript_link.post",
          async () => {
            const binding = await deps.agentDeps.store.getByProviderThread({
              provider: execution.provider,
              providerTenantId: execution.providerTenantId,
              providerConversationId: execution.providerConversationId,
              providerThreadId: execution.providerThreadId,
            });
            if (!binding) {
              throw new Error(
                "The canonical Slack conversation binding is unavailable.",
              );
            }
            await thread.post(
              transcriptCard(transcriptUrl(appUrl, binding.channelsThreadId)),
            );
          },
          logTurnFailure,
        );
      } catch {
        // The agent reply already succeeded. The dedicated phase log keeps this optional demo link
        // observable without turning a completed Slack answer into a provider-visible failure.
      }
    }
  }

  channel.onMention(({ message, thread }) =>
    runLinked({ message, thread, subscribe: true }),
  );
  channel.onMessage(async ({ message, thread }) => {
    if (!isNewMessage(message) || !(await thread.isSubscribed())) return;
    await runLinked({ message, thread, subscribe: false });
  });

  return channel;
}
