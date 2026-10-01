import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { serve } from "bun";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { COMPUTER_GUIDANCE } from "../../shared/bot-prompt";
import { DICTATION_HTTP_IDLE_SECONDS } from "../../shared/dictation";
import { buildResponsibilityTurn } from "../../shared/responsibility-turn";
import { workOwner } from "../../shared/work-owner";
import { createActivityStore } from "./activity/activity";
import {
  auditRoutineStore,
  enterpriseControls,
  guardDeliveryStore,
  guardHostAccess,
  headlessTurnRefusal,
  installEnterpriseControls,
} from "./admin/controls";
import {
  mintRunAssertion,
  type RunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
} from "./agents/callback-token";
import { canUseComputer, computerAccessCheck } from "./agents/computer-access";
import { createAgentFetch } from "./agents/endpoint";
import { createHandoffDesk, HANDOFF_KIND } from "./agents/handoff";
import { createHandoffDelivery } from "./agents/handoff-delivery";
import { createHandoffRunner } from "./agents/handoff-runner";
import { signHandoffDeliveryRun } from "./agents/handoff-signing";
import {
  authoriseCoordinationRun,
  createCoordinationTools,
  readCoordinationHandoffClaim,
} from "./agents/handoff-tool";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
} from "./agents/lifecycle";
import { createBotReset } from "./agents/lifecycle-reset";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import {
  createWakeUpRunner,
  createWakeUpStore,
  wakeUpTools,
} from "./agents/wake-up";
import { createApp } from "./app";
import { createApprovedActionExecutor } from "./approvals/execute";
import {
  PERSON_QUESTION_WAITING,
  resumePersonQuestion,
} from "./approvals/question-resume";
import {
  createApprovalQuestions,
  type PersonQuestion,
  personQuestionSchema,
  questionConversationBot,
} from "./approvals/questions";
import {
  type ApprovalResumeDependencies,
  createApprovalService,
} from "./approvals/service";
import { createApprovalStore } from "./approvals/store";
import {
  ApprovalRefusedError,
  currentApprovalContext,
  parseApprovalContinuation,
  parseApprovalResult,
} from "./approvals/types";
import {
  type AuditInitiator,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { AuthService } from "./auth/guards";
import { createRoleRepository } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { createOrganizationAuth } from "./auth/organization";
import { organizationUserStore } from "./auth/organization-store";
import type { OpenBotRole } from "./auth/roles";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "./channels/attachments";
import {
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import {
  createGroupConversations,
  createGroupStore,
  groupSourceForRun,
} from "./channels/group";
import { createChannelStore } from "./channels/routes";
import { websocket as channelSocket } from "./channels/socket";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerGateway } from "./computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "./computer/headless-tools";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import { withPolicyPushOnWake } from "./computer/policy-network";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { createSnapshotStore } from "./computer/snapshot-store";
import { loadConfig } from "./config";
import {
  type IdentifyActor,
  type IdentifyUser,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  type ToolSelection,
} from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  responsibilityRuns,
  routineRuns,
} from "./db/schema";
import { createDeliveryRouter, DELIVERY_WORK_KINDS } from "./delivery/router";
import {
  configuredDeliveryProviders,
  type DeliveryScopeResolver,
} from "./delivery/routes";
import { createDeliveryStore } from "./delivery/store";
import type { DeliveryScope } from "./delivery/types";
import { DeliveryRefusedError } from "./delivery/types";
import { createDemonstrationRecorder } from "./demonstrations/recording";
import { createDemonstrationStore } from "./demonstrations/store";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { observeIntelligenceAuthentication } from "./intelligence-client";
import { clearLearningRevisionFallback } from "./learning/runtime";
import { createLearningSettingsStore } from "./learning/settings";
import { createMemoryIngestion } from "./memory/ingestion";
import { createMemoryStore } from "./memory/store";
import { memoryTools } from "./memory/tools";
import { createSignInNotifier, createSignInResumer } from "./passwords/resume";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createOnboardingStore } from "./people/onboarding";
import { createPeopleStore } from "./people/store";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { backfillComposioLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import { createPluginStore } from "./plugins/store";
import {
  grantedSkills,
  grantedTools,
  REFUSAL_MARKER,
  vendorAnswer,
} from "./plugins/tools";
import { createProactiveEngine } from "./proactive/engine";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "./proactive/private-share";
import {
  createReadOnlyClassifier,
  guardProactiveCallback,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "./proactive/restriction";
import { createProactiveStore } from "./proactive/store";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createResponsibilityBindingStore } from "./responsibilities/bindings";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  fetchText as fetchSnsText,
  inboundEmailConfigFromEnv,
} from "./responsibilities/email";
import {
  createResponsibilityEngine,
  type ResponsibilityEngine,
} from "./responsibilities/engine";
import {
  createSlackTriggerIngest,
  slackAccessFrom,
  useSlackChannelMembership,
  useSlackTriggerIngest,
} from "./responsibilities/slack";
import { createResponsibilityStore } from "./responsibilities/store";
import { responsibilityTools } from "./responsibilities/tools";
import { createTriggerIngressRoutes } from "./responsibilities/trigger-routes";
import { useTriggerTools } from "./responsibilities/trigger-tools";
import { createTriggerStore } from "./responsibilities/triggers";
import type { Responsibility } from "./responsibilities/types";
import { createTurnRunner } from "./routines/run-turn";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import { createModelCompleter } from "./routing/model";
import { createTeamBots } from "./team-bots/team-bots";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import { markUntrusted } from "./untrusted-content";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { createVoiceSessionStore } from "./voice/sessions";
import { createVoiceSummarizer } from "./voice/summary";
import { repeatAfterEach } from "./work/loop";
import {
  createWorkQueue,
  DEFAULT_MAX_ATTEMPTS,
  startWorkOfferedListener,
  type WorkOfferedListener,
} from "./work/queue";

/**
 * Who is asking, for a CopilotKit request.
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.singleUser) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("A CopilotKit run requires a signed-in user.");
  }
  const roles = user.role
    ? [user.role]
    : await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A CopilotKit run requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** The Intelligence projection of {@link resolveRequestActor}: threads are scoped to this person. */
const identifyUser: IdentifyUser = async (request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

/**
 * The authorization projection of the same person: agent visibility is decided from this.
 *
 * An unauthenticated request resolves to a person who owns nothing rather than an error, so the
 * runtime can still describe itself, `/info` reports the licence and the public roster, which is
 * what a deployment check reads to tell "the licence is invalid" apart from "chat is silently
 * broken". It grants nothing: this actor matches no private profile and is not an administrator,
 * and a run still fails in `identifyUser`, which has no anonymous case because a thread must belong
 * to somebody.
 */
const ANONYMOUS_ACTOR = { id: "", role: "user" } as const;

const identifyActor: IdentifyActor = async (request) => {
  try {
    const { id, role } = await resolveRequestActor(request);
    return { id, role };
  } catch {
    return ANONYMOUS_ACTOR;
  }
};

const config = loadConfig();
// The environment seeds local policy once. The SDK fallback must not reapply an old revision
// after an administrator clears a pin to follow the latest published Skills.
clearLearningRevisionFallback();
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);
// Every dispatch point asks this database whether its person paused the Bot. See agents/lifecycle.ts.
configureBotLifecycle({ database });
const learningSettings = createLearningSettingsStore(database, config.learning);
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgent?.endpoint,
  agentVault,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
const channelEvents = createChannelEventHub();
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
// Its own connection is held for the life of the process; announced activity from any instance
// arrives here and is fanned out to connected members.
const channelActivityListener = await startChannelActivityListener(
  config.databaseUrl,
  channelEvents,
);
const roleRepository = createRoleRepository(database);
const loadAgentsForActor = createRuntimeAgentLoader(
  database,
  agentVault,
  config.managedAgent,
);
await synchronizeTenantPackage(database, tenantPackage);
/*
 * Built before `auth`, because the deny list is consulted during sign-in and the store is what
 * holds it. It needs the administrator list too, so it can tell the screen which people the
 * deployment's configuration has already decided about.
 */
const peopleStore = createPeopleStore(
  database,
  config.auth?.initialAdminEmails ?? [],
  /*
   * Removing somebody retires the credentials they granted this deployment.
   *
   * A closure rather than the method itself, because the plugin store is built further down: this
   * has to exist before `auth` does, and that one needs the vault and the policy. Nothing calls this
   * during module initialisation — it runs when an administrator removes somebody, over HTTP — so by
   * then the binding is there.
   */
  (userId, by) => pluginStore.retireConnectionsFor(userId, by),
);
const identityProviderStore = createIdentityProviderStore(database);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
const signInAuditStore = createAuditStore(database);
const auth: AuthService | undefined = config.organizationAuthUrl
  ? createOrganizationAuth({
      authorityUrl: config.organizationAuthUrl,
      materializeUser: organizationUserStore(database),
    })
  : config.auth
    ? createAuth(
        config,
        database,
        (email) => peopleStore.isRevoked(email),
        signInAuditStore,
      )
    : undefined;
// Each computer is pushed its network policy on the way to the action that woke it, because a
// computer refuses every connection until one arrives (see `withPolicyPushOnWake`).
const computerProvider = config.computer
  ? withPolicyPushOnWake(createComputerProvider(config.computer), {
      policyForBot: (botId) => enterpriseControls()?.policyForBot(botId),
      ...(config.computer.token ? { token: config.computer.token } : {}),
    })
  : undefined;

if (computerProvider?.warm) {
  void computerProvider.warm();
}
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();
/*
 * And kept current afterwards.
 *
 * A boundary an administrator changes arrives at one server. Without this, every other server keeps
 * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
 * and the audit row both report success. See policy-listener.ts.
 */
const policyListener = await startPolicyListener(
  config.databaseUrl,
  policyStore,
);

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);
// One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
const pageFrameStore = createPageFrameStore(database);
let deliveryNotifications: (
  scope: DeliveryScope,
  input: {
    id: string;
    text: string;
    kind: "reply" | "question" | "approval";
    requestId?: string;
  },
) => Promise<void> = async () => {
  throw new Error("Delivery is not initialized.");
};
const authoriseQuestion = async (question: PersonQuestion) => {
  const source = await sourceForCoordinationRun({
    ...question,
    botId: questionConversationBot(question),
    depth: 0,
  });
  if (question.channelId && source?.channelId !== question.channelId)
    throw new ApprovalRefusedError("The saved question source has changed.");
  if (!source)
    throw new ApprovalRefusedError(
      "That conversation is no longer available to this Bot and person.",
    );
  if (
    !(await agentProfileStore.get(
      await actorFor(question.actorId),
      question.botId,
    ))
  )
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
};
const storedApprovals = createApprovalStore(database);
const approvalService = createApprovalService(
  {
    ...storedApprovals,
    open: async (action) => {
      const request = await storedApprovals.open(action);
      if (request.status === "pending") {
        const forwarded = action.continuation?.forwardedProps;
        const signed =
          forwarded &&
          typeof forwarded === "object" &&
          "openbotRun" in forwarded
            ? readRunAssertion(forwarded.openbotRun, config.keyEncryptionKey)
            : null;
        const run =
          signed &&
          signed.actorId === action.actorId &&
          signed.botId === action.botId
            ? signed
            : {
                actorId: action.actorId,
                botId: action.botId,
                runId: action.runId,
                threadId: action.threadId,
                depth: 0,
              };
        const source = await sourceForCoordinationRun(run);
        const botName = source
          ? ((
              await agentProfileStore
                .get(await actorFor(action.actorId), action.botId)
                .catch(() => null)
            )?.name ?? action.botId)
          : action.botId;
        if (source && run.threadId)
          await deliveryNotifications(
            {
              ownerUserId: action.actorId,
              channelId: source.channelId,
              agentId: source.botId,
              threadId: run.threadId,
            },
            {
              id: request.id,
              kind: "approval",
              requestId: request.id,
              text: `${botName} asks for approval to use ${action.toolRef}. Open your OpenBot approval inbox to review this action.`,
            },
          );
      }
      return request;
    },
  },
  createApprovalQuestions(database, authoriseQuestion),
  async (ownerUserId, botId, snapshot) => {
    const source = await sourceForCoordinationRun({
      actorId: ownerUserId,
      botId,
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      depth: 0,
      initiator: PERSON_INITIATOR,
    });
    if (!source)
      throw new ApprovalRefusedError(
        "That conversation is no longer available to this Bot and person.",
      );
    // Intelligence saves a streaming run's messages a moment behind the stream, and the browser runs
    // the tool as soon as the call arrives. A call that is not saved yet is waited for briefly; one
    // that never appears is refused below.
    let history = await routineIntelligence.getThreadMessages({
      threadId: snapshot.threadId,
      userId: ownerUserId,
    });
    const findCall = () =>
      history.messages
        .flatMap((message) => message.toolCalls ?? [])
        .find((call) => call.id === snapshot.toolCallId);
    for (let attempt = 0; !findCall() && attempt < 10; attempt++) {
      await Bun.sleep(500);
      history = await routineIntelligence.getThreadMessages({
        threadId: snapshot.threadId,
        userId: ownerUserId,
      });
    }
    const canonicalCall = findCall();
    if (
      !canonicalCall ||
      canonicalCall.name !== snapshot.toolName ||
      !isDeepStrictEqual(JSON.parse(canonicalCall.args), snapshot.args) ||
      history.messages.some(
        (message) =>
          message.role === "tool" && message.toolCallId === snapshot.toolCallId,
      )
    )
      throw new ApprovalRefusedError(
        "That unanswered tool call is not saved in this conversation.",
      );
    const tools = await approvalComputerTools(
      ownerUserId,
      botId,
      PERSON_INITIATOR,
    );
    const tool = tools.find(
      (tool) => tool.definition.name === snapshot.toolName,
    );
    if (!tool)
      throw new ApprovalRefusedError("That computer tool is not available.");
    return tool.execute(snapshot.args, {
      toolCallId: snapshot.toolCallId,
      signal: new AbortController().signal,
    });
  },
  { review: (prompt, signal) => chooseSkills(prompt, signal) },
);
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      auditStore: bootAuditStore,
      approvalGate: approvalService.gate,
      policy: () => policyStore.get(),
      // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
      // when the snapshot was taken by another server. A Map here would be blank on every replica
      // but the one that snapshotted, and the boundary would decide with no element to look at.
      snapshots: createSnapshotStore(database),
      // So wiping a profile takes the pictures of its signed-in pages with it, which is what the
      // sentence on that button already promised.
      pageFrames: pageFrameStore,
      allowPrivateHosts: config.computer?.allowPrivateHosts,
      token: config.computer?.token,
    })
  : undefined;

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

/**
 * Composio, built ONCE: the client the transport calls through and the broker behind the app
 * directory are the same client, and the store below and the routes further down share it.
 *
 * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
 * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
 * builtin routines transport above is reached — so there is no constructor to hand a client to and
 * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
 * actions seam is installed globally, from here, the one place that has the key. The broker has no
 * such problem: it is an ordinary argument, passed to the store and to `createApp`.
 *
 * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
 * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
 * connector is not configured here; the store gets no broker and the app directory says the same.
 * Installing a client built from an absent key would turn all of that into a vendor error at first
 * use, which sends an operator looking for a broken Composio instead of at their own configuration.
 */
const composio = config.composioApiKey
  ? createComposioClient(config.composioApiKey)
  : null;
if (composio) useComposioClient(composio.actions);

/**
 * The private sign-in form and the Passwords vault. A Bot asks to be signed in; the person answers
 * in a form outside the conversation; the computer types the login. See passwords/service.ts.
 */
const signInService = computerGateway
  ? createSignInService({
      store: createPasswordStore(database),
      gateway: computerGateway,
      // The admin switch, read at call time; installed further down, and absent in scripts.
      passwordManagerEnabled: async (ownerUserId) =>
        (await enterpriseControls()?.capabilityFor(
          ownerUserId,
          "passwordManager",
        )) ?? true,
      encryptionKey: config.keyEncryptionKey,
      auditStore: bootAuditStore,
      notify: createSignInNotifier({
        database,
        appUrl: config.appUrl,
        notify: (scope, input) => deliveryNotifications(scope, input),
      }),
      onResolved: (request) =>
        createSignInResumer({
          database,
          resumeResponsibility: (owner, runId, result) =>
            responsibilityStore.resumeWaiting(owner, runId, result),
          continueTurn: ({ ownerUserId, botId, snapshot, result, messageId }) =>
            approvalContinuationRunner({
              ownerUserId,
              routineId: "sign-in",
              agentId: botId,
              threadId: snapshot.threadId,
              instruction: "",
              initiator: snapshot.initiator ?? PERSON_INITIATOR,
              continuation: { snapshot, result, messageId },
            }),
          recordReply: async ({
            ownerUserId,
            channelId,
            botId,
            text,
            messageId,
          }) => {
            await channelStore.recordActivity(
              await actorFor(ownerUserId),
              channelId,
              { text, agentId: botId, at: new Date() },
              { id: messageId },
            );
          },
        })(request),
    })
  : undefined;

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  approvalGate: approvalService.gate,
  // A connector send to other people asks the owner first. See plugins/share-target.ts.
  privateShareCheck: createPrivateShareCheck({
    approvals: approvalService.store,
  }),
  /*
   * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
   *
   * The same value the connect and callback routes build, from the same config field, because it has
   * to match what was registered character for character. Undefined without a public URL, which is
   * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
   * registering.
   */
  redirectUri: config.publicUrl ? redirectUriFor(config.publicUrl) : undefined,
  /*
   * The same client the transport seam above was installed with, never a second one. Enabling an
   * app writes the row here and creates the auth config at the vendor, and a store holding a
   * different client from the one the call goes out through is two deployments' worth of state
   * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
   * attempted.
   */
  broker: composio?.broker,
});

// Logo metadata is optional; a vendor outage must not prevent the API from starting.
if (composio) {
  void backfillComposioLogos(database, composio.broker).catch(() => {
    console.warn(
      "Composio app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.",
    );
  });
}

/**
 * Routines, and the one moment its tools are told what to act on.
 *
 * The builtin transport is reached as a MODULE — `transportFor` maps a kind to one — so there is no
 * constructor to hand a store to and no request-time seam either: the transport registry is built at
 * import time, long before there is a database. So the store is installed here, once, from the place
 * that already owns building stores. Without this call the four tools are advertised and every one of
 * them refuses, which is the honest behaviour for a deployment that never wired it, and would be a
 * silent outage for this one.
 */
const routineStore = createRoutineStore(database);
useRoutineTools(routineStore);
const responsibilityStore = createResponsibilityStore(database, {
  resolveTarget: async (ownerUserId, agentId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const [bot, channel] = await Promise.all([
      agentProfileStore.get(actor, agentId),
      channelStore.get(actor, channelId),
    ]);
    return bot && channel?.active && channel.agentIds.includes(agentId)
      ? { threadId: channel.threadId }
      : null;
  },
});
const responsibilityBindings = createResponsibilityBindingStore(database, {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
});
/*
 * Event triggers. Every kind authenticates with its vendor's own scheme and then goes through the
 * responsibility engine's one ingest (event + run + queue in one transaction), so dispatch is the
 * same headless AG-UI path as every other responsibility run. `responsibilityEngine` is read at
 * delivery time, long after it is constructed further down.
 */
/*
 * Slack access: the owner's own linked Slack identity comes from the delivery bindings (read at call
 * time; `deliveryStore` is built further down), and channel membership from the Slack pairing via
 * `useSlackChannelMembership`. Until the pairing installs that, Slack triggers are refused.
 */
const slackAccess = slackAccessFrom(async (ownerUserId, teamId) => {
  const bindings = await deliveryStore.listBindings(ownerUserId);
  return (
    bindings.find(
      (binding) =>
        binding.transport === "slack" &&
        binding.realm === teamId &&
        binding.enabled,
    )?.identity ?? null
  );
});
const responsibilityTriggerStore = createTriggerStore(
  database,
  {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: config.keyEncryptionKey,
  },
  { slackAccess },
);
const triggerIngressDeps = {
  directory: responsibilityTriggerStore.directory,
  ingest: (event: unknown) => responsibilityEngine.ingest(event),
  auditStore: bootAuditStore,
};
const inboundEmail = inboundEmailConfigFromEnv(process.env);
const responsibilityTriggers = {
  store: responsibilityTriggerStore,
  emailDomain: inboundEmail?.domain ?? null,
  ingressRoutes: createTriggerIngressRoutes(triggerIngressDeps),
  emailRoutes: inboundEmail
    ? createEmailTriggerRoutes({
        ...triggerIngressDeps,
        config: inboundEmail,
        verify: createSnsVerifier(fetchSnsText),
        confirmSubscription: fetchSnsText,
      })
    : null,
};
// The Slack pairing calls `ingestSlackEvent` from responsibilities/slack.ts; this installs it.
useSlackTriggerIngest(
  createSlackTriggerIngest({ ...triggerIngressDeps, slackAccess }),
);
// Bots manage triggers from chat through the builtin Routines transport; keys never reach the model.
useTriggerTools({
  triggers: responsibilityTriggerStore,
  responsibilities: responsibilityStore,
  publicUrl: config.publicUrl ?? null,
  emailDomain: inboundEmail?.domain ?? null,
});

/**
 * Where a Bot handing work to another gets decided.
 *
 * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
 * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
 * that, because the Bot being addressed will very likely run on a different pod from the Bot that
 * addressed it, and a hop held in memory is lost the moment either is rescheduled.
 */
const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
  // restart.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore
        .botsReachableFrom(fromBotId)
        // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
        // would let a Bot address one nobody gave it because the database blinked.
        .catch(() => [] as string[])
    ).includes(toBotId),
  /*
   * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
   * of the run-building collaborators. It is only ever called during a hop, long after this module
   * has finished loading.
   */
  actorFor: (userId) =>
    // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
    // and the hop is refused with a sentence rather than ending the run in silence.
    actorFor(userId).catch(() => null),
  auditStore: bootAuditStore,
  caps: config.handoff,
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
 * rather than inferred.
 */
const isolation = describeComputerIsolation(computerProvider);

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  initiator: DEPLOYMENT_INITIATOR,
  payload: {
    isolation: isolation.isolation,
    note: isolation.note,
  },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    provider: computerProvider ? computerProvider.name : "none",
    isolation: isolation.isolation,
    ...(isolation.warning ? { warning: isolation.warning } : {}),
  }),
);
/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/**
 * The watch on Bot streams, built once and shared by every run.
 *
 * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
 * running long after the run request has been answered, because in Intelligence mode that request is
 * answered in about a second and the Bot keeps writing for as long as it has something to say.
 *
 * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
 */
const stallGuard = createStallGuard({
  stallMs: config.agentStallTimeoutMs,
  auditStore: bootAuditStore,
});

normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);

const intentRouter = createIntentRouter({
  complete: createModelCompleter({
    model: runtimeModel,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey: config.keyEncryptionKey,
        reader: credentialStore,
        provider: runtimeModel.provider,
        keyId: tenantPackage.model.credentialSecretRef,
        environment: process.env,
      }),
  }),
});

/**
 * Pass one of tool selection: which skills a message needs, on the deployment's own model.
 *
 * Built once rather than per request, because it holds nothing about a person: the key is resolved
 * on every call, so a credential rotated a moment ago is used by the next run.
 */
const chooseSkills = createModelCompleter({
  model: runtimeModel,
  resolveApiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

/*
 * WHY THESE ARE NAMED CONSTANTS RATHER THAN ARGUMENTS WRITTEN INLINE.
 *
 * Two callers now build a Bot: a person's chat request, through `mountCopilotRuntime` below, and a
 * routine's headless turn, through `buildAgentFor` further down. They have to build the SAME Bot. A
 * routine that resolved its tools, its run assertion or its endpoint dialling through a second,
 * slightly different set of collaborators would be a Bot that behaves one way when a person asks and
 * another way at three in the morning, with nothing to point at. So each of these is written once and
 * passed to both.
 */

/** The deployment's model key, resolved per call so a credential rotated a moment ago is used next. */
const resolveRuntimeModelApiKey = () =>
  resolveModelApiKey({
    encryptionKey: config.keyEncryptionKey,
    reader: credentialStore,
    provider: runtimeModel.provider,
    keyId: tenantPackage.model.credentialSecretRef,
    environment: process.env,
  });

const hostAccessBroker = createHostAccessBroker(Date.now, {
  approvalGate: approvalService.gate,
  commandPolicy: (actorId) => approvalService.hostCommandPolicy(actorId),
});

// Tools run here, not in the browser. Each connector still executes through the plugin store, so the
// grant, the policy and the audit row are exactly where they were. Host-folder tools are also
// server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
// receives only opaque grant ids and relative paths.
const personalMemoryStore = createMemoryStore(database);
const demonstrationStore = createDemonstrationStore(database);
const demonstrationRecorder = createDemonstrationRecorder({
  store: demonstrationStore,
  // Teaching a shared deployment Bot is allowed as well as an owned one; the skill is the owner's.
  ownsBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
  ownsSkill: async (owner, slug) =>
    (await pluginStore.skillOwner(slug)) === owner,
  routines: routineStore,
});
const memoryIngestion = createMemoryIngestion({
  store: personalMemoryStore,
  plugins: pluginStore,
  canUseBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
});
// Proactive research may only read; see proactive/restriction.ts. Read from the catalogue per call.
const proactiveReadOnlyRefs = createReadOnlyClassifier(pluginStore);
const loadPersonalMemoryForActor = (ownerUserId: string) => (botId: string) =>
  memoryIngestion.contextFor(ownerUserId, botId);
const memorySweep = repeatAfterEach(async () => {
  try {
    await memoryIngestion.syncDue();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "memory-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        context: { operation: "syncDue" },
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
// Follow-ups a Bot schedules for itself, on the shared work queue. See agents/wake-up.ts.
const wakeUpStore = createWakeUpStore(database, { auditStore: bootAuditStore });
/** Team Bots: published Bots, their audiences, and teammates' consent to their own accounts. */
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) =>
    new Set(
      [
        ...(await pluginStore.connectionsFor(userId)),
        ...(await pluginStore.brokeredConnectionsFor(userId)),
      ].map((connection) => connection.serverId),
    ),
});

const loadToolsForActor =
  (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
  async (botId: string) => [
    ...wakeUpTools({
      store: wakeUpStore,
      ownerUserId: actorId,
      agentId: botId,
      initiator,
    }),
    ...memoryTools({
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }),
    ...(await grantedTools({
      store: pluginStore,
      botId,
      actorId,
      initiator,
      // A Team Bot reaches its owner's accounts, and a teammate's own only with their consent.
      credentialActorFor: teamBots.credentialActorFor(actorId, botId),
    })),
    ...hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      initiator,
    }),
  ];

/** One person's standing instructions, for both the /api/settings routes and every run they start. */
const userInstructionsStore = createUserInstructionsStore(database);

/*
 * What this person has told every built-in coworker they run.
 *
 * Per actor and read per build, for the reason every other per-person fact here is: somebody who
 * edits their instructions and sends a message expects the message to land on the new ones, and a
 * value captured at boot would serve the whole deployment whatever the first person to sign in had
 * written.
 */
const loadInstructionsForActor = (actorId: string) => () =>
  userInstructionsStore.read(actorId);

/*
 * The file behind an attachment reference, read when a turn turns out to name one.
 *
 * Read per turn rather than held, for the reason the bytes are in the database at all: a message
 * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
 * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
 * instead of a link it cannot follow.
 *
 * Built per actor and passed to both turn paths — the request path through `mountCopilotRuntime` and
 * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
 * exactly as a person's chat turn does, on exactly the same footing.
 *
 * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
 * browser-supplied message content, so a turn can name an attachment in a channel the asker was
 * never in — or in one they ARE in but which is not the channel this turn is running in.
 * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
 * run's own thread, and null when there is no row this person may see here.
 * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
 * to somebody who cannot open it.
 *
 * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
 * of these is built per actor per request and then used for however many runs that request makes;
 * a thread captured here would be the first run's, silently, for all of them.
 *
 * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
 * `markAttachmentsSentForActor` below.
 */
const loadAttachmentForActor =
  (actorId: string) => (id: string, threadId: string) =>
    loadAttachmentForTurn(database, { actorId, threadId }, id);

/**
 * That the files on a message went out in it, recorded when a turn turns out to be a send.
 *
 * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
 * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
 * (copilot.ts) calls it with the ids on the message being asked about and no others: history is
 * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
 * of a send.
 *
 * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
 * membership, because members are meant to see each other's sent files; recording a send is scoped
 * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
 * route all read as "this file rode in a message somebody sent" — and a member who could write it
 * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
 * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
 *
 * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
 * A stamp written against a channel that never saw the file freezes the row the same way, and is
 * reached without any colleague being involved: one person, two channels of their own, a file
 * named from the wrong one.
 */
const markAttachmentsSentForActor =
  (actorId: string) => (ids: readonly string[], threadId: string) =>
    markAttachmentsSent(database, { actorId, threadId }, ids);

/*
 * What the deployment tells a remote Bot about the run it is starting.
 *
 * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
 * hands this back when it calls a tool, and it is where the Bot id and the person's name come
 * from: its own token proves which agent is calling, this proves who it is calling for, and
 * neither is read out of the request body any more.
 */
const signRunForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    // How deep in a Bot-to-Bot chain a headless turn already is; see createGroupConversations.
    depth?: number,
  ) =>
  (
    botId: string,
    runId: string,
    threadId?: string,
    previousAssertion?: unknown,
  ) => {
    const previous = readRunAssertion(
      previousAssertion,
      config.keyEncryptionKey,
    );
    if (previous?.handoff) {
      if (previous.botId !== botId || previous.actorId !== actorId)
        throw new Error(
          "The delegated run identity does not match this Bot and owner.",
        );
      return previousAssertion as string;
    }
    return mintRunAssertion(
      {
        botId,
        actorId,
        runId,
        threadId,
        initiator,
        ...(depth ? { depth } : {}),
      },
      config.keyEncryptionKey,
    );
  };

/*
 * Which vendors this deployment connects to, held by a Bot or not.
 *
 * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
 * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
 * Google's sign-in page and asked a person to sign in to an account the deployment had already
 * connected. Naming them lets it say which one it has not been granted instead.
 *
 * Read per request rather than held, because a connector added a minute ago has to count.
 * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
 */
const loadVendors = async () =>
  (await pluginStore.listServers()).map((server) => server.id);

/*
 * How a run's tools are narrowed to the ones it is about.
 *
 * A model picks the right tool reliably out of about ten, and a deployment of this template
 * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
 * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
 * handful is offered the tools of the skills that match the message rather than everything at
 * once. See `plugins/selection.ts`.
 *
 * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
 * `callTool` with the policy and the audit row exactly as before, so every path through here can
 * be wrong without a Bot gaining anything. That is also why every failure below is silent and
 * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
 */
const selectionForActor = (actorId: string): ToolSelection => ({
  loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
  // The deployment's own model and key, the same pair the intent router uses, so selection is
  // never a second thing to configure. It throws on a missing key, which reads as "could not
  // choose" and leaves the whole catalogue offered.
  choose: chooseSkills,
  record: async (botId, selection) => {
    await recordAuditEvent(bootAuditStore, {
      eventType: "mcp.tools_discovered",
      targetType: "bot",
      targetId: botId,
      actorUserId: actorId,
      payload: {
        bot: botId,
        reason: selection.reason,
        granted: selection.granted,
        offered: selection.offered.length,
        skills: selection.skills,
      },
    });
  },
});

// Every run dials the stored endpoint again, so the check that was applied when it was
// registered has to be applied to wherever it redirects now.
// Absent computer configuration means nothing opted into private hosts, which is the safe
// reading and the same one `createApp` takes.
const agentFetch = createAgentFetch({
  allowPrivateHosts: config.computer?.allowPrivateHosts === true,
  // Named addresses are reachable on every hop, not only the one that was registered.
  allowedHosts: config.agentEndpointAllowedHosts,
  // The refusal is what the run already knows; this is what the deployment knows. Written here
  // rather than in `endpoint.ts` so that file keeps deciding and nothing else, the way the
  // target check it reuses does.
  onRefusal: ({ address, reason }) => {
    void recordAuditEvent(bootAuditStore, {
      eventType: "agent.dial_refused",
      targetType: "agent_endpoint",
      targetId: address,
      payload: { address, reason },
    }).catch((error) => {
      // A trail that cannot be written must not take a refusal down with it: the request is
      // already refused by the time this runs, and the alternative to a logged failure here is
      // an unhandled rejection.
      console.error("Could not record a refused agent dial.", error);
    });
  },
});

/**
 * Who a routine acts as, resolved the way {@link resolveRequestActor} resolves it.
 *
 * THE ROLE IS READ, NOT ASSUMED. Which coworkers exist is decided per person and an administrator
 * sees Bots a user does not, so hardcoding `role: "user"` here would hide an administrator's own Bots
 * from their own routine — the routine would fail with "that Bot is no longer registered" for a Bot
 * sitting in front of them in chat. This asks the same repository the request path asks, so a routine
 * sees exactly the coworkers its owner sees.
 */
const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
  // One person, and they are an administrator. The id stays the routine owner's rather than being
  // rewritten to DEV_ACTOR's: in this mode they are the same person, and if they ever were not,
  // silently borrowing the dev actor's identity would be worse than finding nothing.
  if (config.singleUser) return { id: ownerUserId, role: DEV_ACTOR.role };
  const roles = await roleRepository.rolesForUser(ownerUserId);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("A routine requires an authorized owner.");
  }
  return {
    id: ownerUserId,
    role: roles.includes("admin") ? "admin" : "user",
  };
};

/*
 * A run's source conversation: a channel's own thread, or a Bot's thread in a group conversation.
 * The group lookup applies the same live-membership and own-Bot checks. See channels/group.ts.
 */
const sourceForCoordinationRun = async (run: RunAssertion) =>
  (await channelSourceForRun(run)) ?? groupSourceForRun(database, run);
const channelSourceForRun = async (run: RunAssertion) => {
  if (!run.threadId) return null;
  const sources = await database
    .select({ channelId: channels.id, botId: channelAgents.agentId })
    .from(intelligenceChannelMappings)
    .innerJoin(channels, eq(channels.id, intelligenceChannelMappings.channelId))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channels.id),
        eq(channelMemberships.userId, run.actorId),
      ),
    )
    .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
    .where(
      and(
        eq(intelligenceChannelMappings.threadId, run.threadId),
        eq(intelligenceChannelMappings.userId, run.actorId),
        isNull(channels.deletedAt),
      ),
    );
  return (
    sources.find((source) => source.botId === run.botId) ??
    (run.handoff ? (sources[0] ?? null) : null)
  );
};
const personQuestions = createWorkQueue(database);
const coordination = createCoordinationTools({
  desk: handoffDesk,
  caps: config.handoff,
  approvalGate: approvalService.gate,
  privateShare: {
    check: createPrivateShareCheck({ approvals: approvalService.store }),
    // Resolved the way the desk resolves it: an id wins, then a single visible name. Null for the
    // owner's own Bot or a deployment Bot, since nobody else reads that work.
    audienceFor: async (from, target) => {
      const roster = await agentProfileStore.list(await actorFor(from.actorId));
      const wanted = target.trim().toLowerCase();
      const found =
        roster.find((candidate) => candidate.id.toLowerCase() === wanted) ??
        roster.find(
          (candidate) =>
            !candidate.hidden &&
            candidate.deletedAt === null &&
            candidate.name.toLowerCase() === wanted,
        );
      if (!found?.ownerUserId || found.ownerUserId === from.actorId)
        return null;
      return {
        kind: "handoff",
        id: found.ownerUserId,
        recipientUserIds: [found.ownerUserId],
        label: found.name,
      };
    },
    // A question from a conversation other people are in reaches them too, so it is held like a
    // handoff to another person. Only the owner reading it is the ordinary, unheld case.
    questionAudience: async (from) => {
      const channel = await channelSourceForRun(from);
      const group = channel ? null : await groupSourceForRun(database, from);
      const source = channel ?? group;
      if (!source) return null;
      const members = (
        await database
          .select({ userId: channelMemberships.userId })
          .from(channelMemberships)
          .where(eq(channelMemberships.channelId, source.channelId))
      ).map((row) => row.userId);
      if (members.every((userId) => userId === from.actorId)) return null;
      return {
        audience: {
          kind: group ? "group" : "channel",
          id: source.channelId,
          recipientUserIds: members,
        },
        // A channel thread is the conversation itself; a group Bot's own thread also holds context
        // only its owner has seen.
        origin: channel
          ? { kind: "shared_conversation", sharedWithUserIds: members }
          : { kind: "private_conversation" },
      };
    },
  },
  botsReachableFrom: (botId) => pluginStore.botsReachableFrom(botId),
  auditStore: bootAuditStore,
  authoriseRun: (run) =>
    authoriseCoordinationRun(run, {
      canUseBot: async (scope) => {
        const person = await peopleStore.find(scope.actorId);
        if (!person || person.revoked) return false;
        return (
          (await agentProfileStore.get(
            await actorFor(scope.actorId),
            scope.botId,
          )) !== null
        );
      },
      sourceThread: sourceForCoordinationRun,
      delegationFor: (claim) => readCoordinationHandoffClaim(database, claim),
    }),
  route: async (question) => {
    const source = await sourceForCoordinationRun(question);
    if (!source)
      return {
        refusal: "That question could not reach its source conversation.",
      };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          question.actorId,
          question.botId,
          question.runId,
          question.question,
        ]),
      )
      .digest("hex");
    const queued = await personQuestions.offer({
      kind: "person.question",
      key,
      payload: {
        ...question,
        sourceBotId: source.botId,
        channelId: source.channelId,
        mode: "completed_question",
        toolName: "ask_person",
        args: {
          question: question.question,
          ...(question.why ? { why: question.why } : {}),
        },
      },
    });
    if (queued === "refused")
      return { refusal: "The question could not be saved for its person." };
    await channelStore.recordActivity(
      await actorFor(question.actorId),
      source.channelId,
      {
        text: `A question needs your answer: ${question.question}`,
        agentId: source.botId,
        at: new Date(),
      },
      { id: `question:${key}` },
    );
    if (question.threadId) {
      // A person reads this in Slack or on their phone, where "general-assistant" is an id, not a name.
      const botName =
        (
          await agentProfileStore
            .get(await actorFor(question.actorId), question.botId)
            .catch(() => null)
        )?.name ?? question.botId;
      await deliveryNotifications(
        {
          ownerUserId: question.actorId,
          channelId: source.channelId,
          agentId: source.botId,
          threadId: question.threadId,
        },
        {
          id: key,
          text: `${botName} asks: ${question.question}`,
          kind: "question",
          requestId: key,
        },
      );
    }
    return {
      reached:
        "the person in the source conversation; the question is saved awaiting their reply",
    };
  },
});
const coordinationForActor =
  (
    actorId: string,
    initiator: AuditInitiator = PERSON_INITIATOR,
    baseDepth = 0,
  ) =>
  async (botId: string, input: import("@ag-ui/client").RunAgentInput) => {
    const assertion = readRunAssertion(
      input.forwardedProps?.openbotRun,
      config.keyEncryptionKey,
    );
    if (
      assertion &&
      (assertion.botId !== botId || assertion.actorId !== actorId)
    )
      throw new Error("The run assertion does not match this Bot and owner.");
    const run: RunAssertion = assertion?.handoff
      ? assertion
      : {
          botId,
          actorId,
          runId: input.runId,
          threadId: input.threadId,
          depth: assertion?.depth ?? baseDepth,
          initiator: assertion?.initiator ?? initiator,
        };
    const tools = await coordination.toolsForRun(run);
    return tools.map((tool) => ({
      ...tool,
      execute: async (args: unknown) => {
        if (!args || typeof args !== "object" || Array.isArray(args))
          return `${REFUSAL_MARKER} Tool arguments must be an object.`;
        const result = await coordination.call({
          name: tool.name,
          args: args as Record<string, unknown>,
          run,
        });
        if (!result) throw new Error("A coordination tool was not dispatched.");
        /*
         * A responsibility's question pauses its run, the way an approval does.
         *
         * Left running, the run ended "succeeded" the moment the question was saved, and the answer
         * came back to a run that was already over: the Bot read it, and then the store refused its
         * progress because it was not from the responsibility's current run, so the goal stayed
         * open for ever. Suspended, the run waits, and the answer resumes that same run as this
         * tool's result, with the right to record progress and finish.
         */
        const snapshot = currentApprovalContext();
        if (
          tool.name === "ask_person" &&
          run.initiator?.kind === "responsibility" &&
          snapshot &&
          !result.text.startsWith(REFUSAL_MARKER)
        )
          throw new HeadlessToolSuspension(
            "This responsibility is waiting for the person's answer.",
            {
              kind: PERSON_QUESTION_WAITING,
              continuation: snapshot,
            },
          );
        return result.text;
      },
    }));
  };

/**
 * One Bot, built for a routine's turn, as its owner.
 *
 * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
 * edited since the last firing has to count, and a private coworker must be absent for everybody but
 * its owner. No header and no request are involved — the owner is asserted by construction, from the
 * routine row — which is the whole point of doing it here rather than adding an impersonation path to
 * a public route.
 */
const buildAgentFor = async ({
  ownerUserId,
  agentId,
  initiator,
  depth,
}: {
  ownerUserId: string;
  agentId: string;
  initiator: AuditInitiator;
  depth?: number;
}) => {
  const actor = await actorFor(ownerUserId);
  const agents = await resolveRuntimeAgents(
    () => loadAgentsForActor(actor),
    runtimeModel,
    resolveRuntimeModelApiKey,
    stallGuard,
    restrictToolsForRun(
      initiator,
      loadToolsForActor(actor.id, initiator),
      proactiveReadOnlyRefs,
    ),
    signRunForActor(actor.id, initiator, depth),
    config.computer ? COMPUTER_GUIDANCE : undefined,
    loadVendors,
    selectionForActor(actor.id),
    agentFetch,
    restrictCoordinationForRun(
      initiator,
      coordinationForActor(actor.id, initiator, depth),
    ),
    // Only the Bot this routine names. Same reason as the hop delivery: the roster is still read in
    // full so a Bot this owner cannot see is still absent, but the other Bots are neither built nor
    // asked what they hold.
    agentId,
    // The owner's own standing instructions. A routine is their work done while they are asleep, so
    // it is written the way they asked for it to be written, exactly as their chat turn would be.
    loadInstructionsForActor(actor.id),
    initiator,
    // The same reader the request path gets, bound to the owner the routine runs as, so a file
    // attached in a channel reads the same way on a routine's turn as it does on the person's own —
    // and is refused the same way when the owner is not in that channel.
    loadAttachmentForActor(actor.id),
    // And the same recorder, so the files on a routine's own message stop counting as staged the
    // moment it sends them, exactly as a person's do.
    markAttachmentsSentForActor(actor.id),
    copilotRuntime.learning?.acquire,
    loadPersonalMemoryForActor(actor.id),
  );
  const agent = agents[agentId];
  if (!agent) {
    /*
     * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
     * somebody else, or the owner lost the role that could see it. The runner turns this into a
     * failed run row with this sentence on it, the first failure is said once in the channel, and
     * the fatigue rule switches the routine off after ten — which is exactly the right handling for
     * a routine pointed at something that is not coming back.
     */
    const error = new Error(
      `That Bot is no longer registered, so this routine has nothing to run: ${agentId}.`,
    );
    error.name = "RoutineBotNotRegistered";
    throw error;
  }
  return agent;
};

/*
 * The pair a headless turn is driven through, built ONCE.
 *
 * Not the runtime's own pair: `mountCopilotRuntime` keeps its client and its runner inside
 * `CopilotRuntime` and hands neither back, and reaching into that object would be a worse seam than
 * building our own from the same three settings. Built from `config.runtime.intelligence`, which is
 * required and not optional — `RuntimeCapabilities` has exactly one mode and every Intelligence field
 * with it (`config.ts:10-22`), and `loadConfig` refuses to boot without them — so there is no
 * not-in-Intelligence-mode branch to write here. If a second mode is ever added, THIS is the line that
 * has to grow a guard, and the routine runner must then be left off `createApp` entirely.
 *
 * One runner for the process, reused across firings: it opens a socket per run and holds no idle
 * connection, but its `threads` map is per instance, and a runner per turn would fragment the
 * already-running check that keeps two turns off one thread. See `routines/run-turn.ts`.
 */
const routineIntelligence = observeIntelligenceAuthentication(
  new CopilotKitIntelligence({
    apiUrl: config.runtime.intelligence.apiUrl,
    wsUrl: config.runtime.intelligence.gatewayWsUrl,
    apiKey: config.runtime.intelligence.apiKey,
  }),
);
const routineAgentRunner = new IntelligenceAgentRunner({
  url: routineIntelligence.ɵgetRunnerWsUrl(),
  authToken: routineIntelligence.ɵgetRunnerAuthToken(),
});

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
      if (!canUseComputer(profile, actor)) return [];
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
});

/**
 * The runtime, and the two things beside it a hop needs.
 *
 * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
 * the conversation through the same client. Taken from here rather than assembled again, because a
 * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
 * invisible: it runs, and quietly holds different tools or a different role from the one the person
 * is talking to.
 */
const copilotRuntime = mountCopilotRuntime(
  config,
  runtimeModel,
  loadAgentsForActor,
  resolveRuntimeModelApiKey,
  identifyUser,
  identifyActor,
  stallGuard,
  loadToolsForActor,
  signRunForActor,
  undefined,
  loadVendors,
  selectionForActor,
  agentFetch,
  /*
   * What a Bot may reach past itself for: another Bot, and a person. Made per run and per person.
   *
   * Per person because which Bots may be reached is decided against the roster that person can
   * see: a Bot must never be able to address one they cannot, or this becomes a way around agent
   * visibility. Per run because the caps need to know how deep the chain already is and where an
   * answer belongs, and both of those are the deployment's own statement about the run rather than
   * anything the model can edit.
   */
  coordinationForActor,
  // A run started or ended on a thread; light the channel it belongs to. Fire-and-forget, keyed by
  // thread, and a scratch thread maps to no channel and signals nowhere.
  (input) => {
    void channelStore.signalBusy(input.threadId, input.busy).catch(() => {});
  },
  // What this person has told every coworker of theirs, in every channel. See user-instructions.ts.
  loadInstructionsForActor,
  // The files on a message, put in front of the model rather than left as links it cannot follow —
  // and only the ones the person whose run this is could open themselves.
  loadAttachmentForActor,
  // And that those files went out in a send, written by the person who sent them and only for rows
  // they uploaded. See markAttachmentsSentForActor.
  markAttachmentsSentForActor,
  learningSettings,
  loadPersonalMemoryForActor,
);

const responsibilityQueue = createWorkQueue(database);
const responsibilityEngine: ResponsibilityEngine = createResponsibilityEngine({
  store: responsibilityStore,
  queue: responsibilityQueue,
  runTurn: async (context) => {
    const initiator: AuditInitiator = {
      kind: "responsibility",
      id: context.responsibilityId,
    };
    const tools = responsibilityTools({
      store: responsibilityStore,
      engine: responsibilityEngine,
      ownerUserId: context.ownerUserId,
      agentId: context.agentId,
      channelId: context.channelId,
      responsibilityRunId: context.runId,
    });
    const runner = createTurnRunner({
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      components: { store: componentStore, auditStore: bootAuditStore },
      buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
      toolsForTurn: async () => {
        const actor = await actorFor(context.ownerUserId);
        // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
        const computer =
          computerGateway &&
          canUseComputer(
            await agentProfileStore
              .get(actor, context.agentId)
              .catch(() => null),
            actor,
          )
            ? createHeadlessComputerTools({
                gateway: computerGateway,
                botId: context.agentId,
                actor: { id: actor.id, userId: actor.id, initiator },
                auditStore: bootAuditStore,
                ...(signInService ? { signIn: signInService } : {}),
              })
            : [];
        return [
          ...computer,
          ...tools.map((tool) => ({
            definition: {
              name: tool.name,
              description: tool.description,
              parameters: z.toJSONSchema(tool.parameters),
            },
            execute: (args: unknown) => tool.execute(args),
          })),
        ];
      },
      learningContainerForThread: (input) =>
        copilotRuntime.learning?.containerForThread(input) ??
        Promise.resolve(undefined),
    });
    const saved = context.continuation;
    const snapshot = saved
      ? parseApprovalContinuation(saved.waiting.continuation)
      : undefined;
    const toolResult = saved ? parseApprovalResult(saved.response) : undefined;
    return runner({
      ownerUserId: context.ownerUserId,
      routineId: context.responsibilityId,
      agentId: context.agentId,
      threadId: context.threadId,
      initiator,
      signal: context.signal,
      ...(snapshot && toolResult
        ? {
            continuation: {
              snapshot,
              result: toolResult,
              messageId: `responsibility-result:${context.runId}:${snapshot.toolCallId}`,
            },
          }
        : {}),
      instruction: buildResponsibilityTurn({
        instruction: context.instruction,
        successCriteria: context.successCriteria,
        progress: context.progress,
        trigger: context.event,
        eventData: markUntrusted(
          JSON.stringify(context.event.payload),
          `${context.event.source} event`,
        ),
        responsibilityId: context.responsibilityId,
      }),
    });
  },
  onReply: async (context, text) => {
    await channelStore.recordActivity(
      await actorFor(context.ownerUserId),
      context.channelId,
      { text, agentId: context.agentId, at: new Date() },
      { id: `responsibility:${context.runId}` },
    );
    await deliveryNotifications(
      {
        ownerUserId: context.ownerUserId,
        channelId: context.channelId,
        agentId: context.agentId,
        threadId: context.threadId,
      },
      { id: `responsibility:${context.runId}`, kind: "reply", text },
    );
  },
});
/**
 * A turn for a responsibility that is not one of the engine's own firings: a person answering the
 * question its run asked. Same tools, same initiator and the same run to report progress against,
 * so the Bot can carry on with the goal instead of being unable to record it.
 */
const responsibilityAnswerTurn = ({
  responsibility,
  responsibilityRunId,
}: {
  responsibility: Responsibility;
  responsibilityRunId: string | undefined;
}) => {
  const initiator: AuditInitiator = {
    kind: "responsibility",
    id: responsibility.id,
  };
  const tools = responsibilityTools({
    store: responsibilityStore,
    engine: responsibilityEngine,
    ownerUserId: responsibility.ownerUserId,
    agentId: responsibility.agentId,
    channelId: responsibility.channelId,
    ...(responsibilityRunId ? { responsibilityRunId } : {}),
  });
  return createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
    toolsForTurn: async () => [
      ...(await approvalComputerTools(
        responsibility.ownerUserId,
        responsibility.agentId,
        initiator,
      )),
      ...tools.map((tool) => ({
        definition: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.parameters),
        },
        execute: (args: unknown) => tool.execute(args),
      })),
    ],
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  });
};
const responsibilitySweep = repeatAfterEach(async () => {
  try {
    const report = await responsibilityEngine.dispatch({
      owner: workOwner("responsibility"),
      limit: 1,
    });
    if (
      report.succeeded.length ||
      report.failed.length ||
      report.waiting.length
    )
      console.info(
        JSON.stringify({ type: "responsibility-dispatch", ...report }),
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "responsibility-dispatch-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);

const approvalQueue = createWorkQueue(database);
const approvalOwner = workOwner("approval");
const approvalComputerTools = async (
  ownerUserId: string,
  agentId: string,
  initiator: AuditInitiator,
) => {
  const actor = await actorFor(ownerUserId);
  const profile = await agentProfileStore.get(actor, agentId);
  if (!profile)
    throw new ApprovalRefusedError("That Bot is no longer available to you.");
  // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
  return computerGateway && canUseComputer(profile, actor)
    ? createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      })
    : [];
};
const executeApprovedAction = createApprovedActionExecutor({
  sourceFor: sourceForCoordinationRun,
  gate: approvalService.gate,
  computerTools: approvalComputerTools,
  hostTools: ({ actorId, botId, initiator }) =>
    hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      initiator,
      auditStore: bootAuditStore,
    }),
  callTool: (input) => pluginStore.callTool(input),
  credentialActorFor: (actorId, botId, ref) =>
    teamBots.credentialActorFor(actorId, botId)(ref),
  coordinationCall: (input) => coordination.call(input),
  readRun: (value) => readApprovedRunAssertion(value, config.keyEncryptionKey),
  answer: vendorAnswer,
  privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
  refusalMarker: REFUSAL_MARKER,
  personInitiator: PERSON_INITIATOR,
});
const approvalContinuationRunner = createTurnRunner({
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  components: { store: componentStore, auditStore: bootAuditStore },
  buildAgentFor,
  toolsForTurn: async ({ ownerUserId, agentId, initiator }) =>
    approvalComputerTools(ownerUserId, agentId, initiator),
  learningContainerForThread: (input) =>
    copilotRuntime.learning?.containerForThread(input) ??
    Promise.resolve(undefined),
});
const approvalSweep = repeatAfterEach(async () => {
  try {
    const [item] = await approvalQueue.claim({
      kind: "approval.resume",
      owner: approvalOwner,
      leaseMs: 15 * 60_000,
      limit: 1,
    });
    if (!item) return;
    // Set once the item is understood, so its last failed try can still tell the Bot.
    let abandon: ((reason: string) => Promise<void>) | undefined;
    try {
      const input = z
        .object({
          ownerUserId: z.string().min(1),
          approvalId: z.string().min(1),
        })
        .parse(item.payload);
      const resumeDependencies: ApprovalResumeDependencies = {
        // Asked before the action runs: with Use Bots off, or the Bot's model off the allowlist,
        // nothing is carried out and the refusal is final rather than retried.
        refusal: (action) =>
          headlessTurnRefusal({
            ownerUserId: action.actorId,
            agentId: action.botId,
          }),
        validate: (action) =>
          approvalService.validateReentry(action, () =>
            executeApprovedAction(action),
          ),
        execute: executeApprovedAction,
        continue: async ({
          continuation: snapshot,
          result,
          messageId,
          approvalId,
        }) => {
          const [waitingRun] = await database
            .select({ id: responsibilityRuns.id })
            .from(responsibilityRuns)
            .where(
              and(
                eq(responsibilityRuns.status, "waiting"),
                sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
              ),
            )
            .limit(1);
          if (waitingRun) {
            await responsibilityStore.resumeWaiting(
              input.ownerUserId,
              waitingRun.id,
              result,
            );
            return;
          }
          const request = await approvalService.store.get(
            input.ownerUserId,
            approvalId,
          );
          // A group turn's approval also writes the resumed reply into the shared transcript.
          const outcome = await groupConversations.continueWaiting(
            approvalId,
            () =>
              approvalContinuationRunner({
                ownerUserId: input.ownerUserId,
                routineId: "approval",
                agentId: request.action.botId,
                threadId: snapshot.threadId,
                instruction: "",
                initiator: snapshot.initiator ?? PERSON_INITIATOR,
                continuation: { snapshot, result, messageId },
              }),
          );
          const [source] = await database
            .select({ channelId: intelligenceChannelMappings.channelId })
            .from(intelligenceChannelMappings)
            .where(
              and(
                eq(intelligenceChannelMappings.userId, input.ownerUserId),
                eq(intelligenceChannelMappings.threadId, snapshot.threadId),
              ),
            )
            .limit(1);
          if (source && outcome.replyText)
            await channelStore.recordActivity(
              await actorFor(input.ownerUserId),
              source.channelId,
              {
                text: outcome.replyText,
                agentId: request.action.botId,
                at: new Date(),
              },
              { id: messageId },
            );
          // A decision made in Slack, SMS or the phone gets its result back there too.
          if (source && outcome.replyText)
            await deliveryNotifications(
              {
                ownerUserId: input.ownerUserId,
                channelId: source.channelId,
                agentId: request.action.botId,
                threadId: snapshot.threadId,
              },
              { id: messageId, text: outcome.replyText, kind: "reply" },
            );
          await database
            .update(routineRuns)
            .set({
              status: "succeeded",
              finishedAt: new Date(),
              error: null,
              waiting: null,
            })
            .where(
              and(
                eq(routineRuns.status, "waiting"),
                sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
              ),
            );
        },
      };
      abandon = (reason) =>
        approvalService.abandon(
          input.ownerUserId,
          input.approvalId,
          reason,
          resumeDependencies,
        );
      await approvalService.resume(
        input.ownerUserId,
        input.approvalId,
        resumeDependencies,
      );
      if (
        !(await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: approvalOwner,
        }))
      )
        throw new Error("The approval work lease was lost before completion.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The queue will not hand this item out again, so the conversation hears now or never.
      if (abandon && item.attempts >= DEFAULT_MAX_ATTEMPTS) {
        try {
          await abandon(reason);
          await approvalQueue.finish({
            kind: item.kind,
            key: item.key,
            owner: approvalOwner,
          });
          return;
        } catch (failure) {
          console.error(
            JSON.stringify({
              type: "approval-abandon-error",
              error:
                failure instanceof Error ? failure.message : String(failure),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
      await approvalQueue.release({
        kind: item.kind,
        key: item.key,
        owner: approvalOwner,
        delayMs: 10_000,
        reason,
      });
      throw error;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "approval-resume-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);
const deliveryStore = createDeliveryStore(database);
const deliveryProviders = configuredDeliveryProviders(
  config.publicUrl ?? config.auth?.baseUrl ?? `http://localhost:${config.port}`,
);
// Slack channel membership for triggers is answered by OpenTag, which holds the workspace token.
useSlackChannelMembership((input) =>
  deliveryProviders.slack
    ? deliveryProviders.slack.isMember(input)
    : Promise.resolve(false),
);
const deliveryScopeFor: DeliveryScopeResolver = async (
  ownerUserId,
  channelId,
  agentId,
) => {
  const person = await peopleStore.find(ownerUserId);
  if (!person || person.revoked) return null;
  const actor = await actorFor(ownerUserId);
  const [channel, bot] = await Promise.all([
    channelStore.get(actor, channelId),
    agentProfileStore.get(actor, agentId),
  ]);
  return channel?.active && bot && channel.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};
const authoriseDeliveryScope = async (scope: DeliveryScope) =>
  (await deliveryScopeFor(scope.ownerUserId, scope.channelId, scope.agentId))
    ?.threadId === scope.threadId;
const deliveryRouter = createDeliveryRouter({
  store: deliveryStore,
  queue: createWorkQueue(database),
  owner: workOwner("delivery"),
  providers: deliveryProviders,
  authoriseScope: authoriseDeliveryScope,
  notifyEvent: (event) => responsibilityEngine.ingest(event),
  runTurn: async (input) => {
    if (!(await authoriseDeliveryScope(input)))
      throw new Error(
        "The delivery owner no longer has access to this conversation.",
      );
    const actor = await actorFor(input.ownerUserId);
    await channelStore.recordActivity(
      actor,
      input.channelId,
      { text: input.text, agentId: null, at: new Date() },
      { id: `delivery-input:${input.runId}` },
    );
    await channelStore.signalBusy(input.threadId, true);
    try {
      const result = await approvalContinuationRunner({
        ownerUserId: input.ownerUserId,
        routineId: `delivery:${input.runId}`,
        runId: input.runId,
        agentId: input.agentId,
        threadId: input.threadId,
        instruction: input.text,
        userMessage: {
          id: `delivery:${input.runId}`,
          role: "user",
          content: input.text,
        },
        initiator: PERSON_INITIATOR,
        signal: input.signal,
      });
      if (result.replyText)
        await channelStore.recordActivity(
          actor,
          input.channelId,
          { text: result.replyText, agentId: input.agentId, at: new Date() },
          { id: `delivery-reply:${input.runId}` },
        );
      return result;
    } finally {
      await channelStore.signalBusy(input.threadId, false);
    }
  },
  audit: (event) =>
    recordAuditEvent(bootAuditStore, {
      actorUserId: event.ownerUserId,
      initiator: PERSON_INITIATOR,
      eventType:
        event.kind === "inbound"
          ? "delivery.received"
          : event.kind === "sms_opt_out"
            ? "delivery.opted_out"
            : event.state === "failed"
              ? "delivery.failed"
              : "delivery.sent",
      targetType: "channel",
      targetId: event.channelId,
      payload: { deliveryId: event.id, kind: event.kind, state: event.state },
    }),
});
deliveryNotifications = (scope, input) => deliveryRouter.notify(scope, input);

/*
 * Proactive research: an opted-in Bot reading its owner's apps in the background, restricted to
 * reads by its initiator (see proactive/restriction.ts), through the same headless turn runner and
 * work queue as routines. Suggestions go to the web inbox and the owner's delivery routing.
 */
const proactiveStore = createProactiveStore(database);
const proactiveEngine = createProactiveEngine({
  store: proactiveStore,
  memory: personalMemoryStore,
  queue: createWorkQueue(database),
  owner: workOwner("proactive"),
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    buildAgentFor,
    // Only the run's own two tools and refusals: no computer, no components.
    toolsForTurn: (input) => proactiveEngine.toolsForTurn(input),
    turnTimeoutMs: 3 * 60_000,
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
  resolveScope: deliveryScopeFor,
  notify: (scope, input) => deliveryNotifications(scope, input),
  startTask: async (scope, input) => {
    const actor = await actorFor(scope.ownerUserId);
    await channelStore.recordActivity(
      actor,
      scope.channelId,
      { text: input.text, agentId: null, at: new Date() },
      { id: `${input.runId}:input` },
    );
    const result = await approvalContinuationRunner({
      ...scope,
      routineId: input.runId,
      instruction: input.text,
      userMessage: { id: input.runId, role: "user", content: input.text },
      initiator: PERSON_INITIATOR,
      signal: input.signal,
    });
    if (result.replyText)
      await channelStore.recordActivity(
        actor,
        scope.channelId,
        { text: result.replyText, agentId: scope.agentId, at: new Date() },
        { id: `${input.runId}:reply` },
      );
  },
  catalogue: pluginStore,
  deniedToolNames: async (ownerUserId, agentId) => {
    const [tools, allowed] = await Promise.all([
      loadToolsForActor(ownerUserId)(agentId),
      proactiveReadOnlyRefs(),
    ]);
    return tools
      .filter((tool) => !allowed.has(tool.ref) && !allowed.has(tool.name))
      .map((tool) => tool.name);
  },
  mintThreadId: () => threadIdentity.mint(),
});
const proactiveSweep = repeatAfterEach(async () => {
  try {
    await proactiveEngine.sweep();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "proactive-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
/*
 * Follow-ups a Bot scheduled for itself: one headless turn each, through the same turn runner as a
 * routine, into the person's conversation with that Bot. See agents/wake-up.ts.
 */
const wakeUpQueue = createWorkQueue(database);
const wakeUpRunner = createWakeUpRunner({
  queue: wakeUpQueue,
  store: wakeUpStore,
  owner: workOwner("wake-up"),
  actorFor,
  channels: channelStore,
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
      if (!canUseComputer(profile, actor)) return [];
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
  notify: (scope, input) => deliveryNotifications(scope, input),
});
const wakeUpSweep = repeatAfterEach(async () => {
  try {
    const report = await wakeUpRunner.sweep();
    if (report.ran.length || report.skipped.length)
      console.info(JSON.stringify({ type: "bot-follow-up", ...report }));
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "bot-follow-up-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 5_000);
const wakeUpReaper = repeatAfterEach(async () => {
  await wakeUpRunner.reap().catch(() => 0);
}, 60 * 60_000);
const deliverySweeps = DELIVERY_WORK_KINDS.map((kind) =>
  repeatAfterEach(async () => {
    try {
      await deliveryRouter.sweep(kind);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "delivery-worker-error",
          kind,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }, 2_000),
);

const personResponseOwner = workOwner("person-response");
/**
 * Conversations with several Bots. Each Bot turn is an ordinary headless AG-UI turn into that Bot's
 * own group thread, built exactly as a routine's is, so governance, learning and the computer tools
 * apply unchanged; Bots answering each other reuse the handoff desk's grant and caps.
 */
const groupConversations = createGroupConversations({
  store: createGroupStore(database, () => threadIdentity.mint()),
  queue: createWorkQueue(database),
  owner: workOwner("group"),
  roster: async (ownerUserId, channelId) => {
    const actor = await actorFor(ownerUserId);
    const channel = await channelStore.get(actor, channelId);
    if (!channel || channel.agentIds.length < 2) return null;
    const bots: { id: string; name: string }[] = [];
    for (const agentId of channel.agentIds) {
      const profile = await agentProfileStore.get(actor, agentId);
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  },
  runTurn: createTurnRunner({
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: { store: componentStore, auditStore: bootAuditStore },
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
      if (!canUseComputer(profile, actor)) return [];
      return createHeadlessComputerTools({
        gateway: computerGateway,
        botId: agentId,
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      });
    },
    learningContainerForThread: (input) =>
      copilotRuntime.learning?.containerForThread(input) ??
      Promise.resolve(undefined),
  }),
  caps: config.handoff,
  // The handoff desk's own grant check, read per hop and failing closed.
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  auditStore: bootAuditStore,
  activity: async (turn, agentId, text, sourceId) =>
    channelStore.recordActivity(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      { text, agentId, at: new Date() },
      { id: sourceId },
    ),
  busy: async (turn, busy) =>
    channelStore.signalChannelBusy(
      await actorFor(turn.ownerUserId),
      turn.channelId,
      busy,
    ),
  createChannel: async (ownerUserId, agentIds) =>
    channelStore.create(await actorFor(ownerUserId), agentIds),
  // The owner says whether a Bot's words may reach the other people in a group.
  privateShare: createPrivateShareCheck({ approvals: approvalService.store }),
  // A Team Bot's consent card raised in a group turn is drawn in the shared transcript.
  listenForConsent: (ownerUserId, agentId) =>
    teamBots.listenForConsent(ownerUserId, agentId),
});
const groupSweep = repeatAfterEach(async () => {
  try {
    while (await groupConversations.sweep()) {}
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "group-sweep-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 1_000);

const personResponseSweep = repeatAfterEach(async () => {
  try {
    const [item] = await approvalQueue.claim({
      kind: "person.response",
      owner: personResponseOwner,
      leaseMs: 10 * 60_000,
      limit: 1,
      maxAttempts: 1,
    });
    if (!item) return;
    try {
      const payload = z
        .object({
          ownerUserId: z.string().min(1),
          // The saved question, initiator included, so the answer resumes the turn that asked.
          question: personQuestionSchema,
          response: z.string().min(1).max(6000),
        })
        .parse(item.payload);
      if (payload.ownerUserId !== payload.question.actorId)
        throw new ApprovalRefusedError(
          "The saved question owner does not match.",
        );
      await authoriseQuestion(payload.question);
      const outcome = await resumePersonQuestion({
        ownerUserId: payload.ownerUserId,
        question: payload.question,
        response: payload.response,
        messageId: `person-response:${item.key}`,
        runTurn: approvalContinuationRunner,
        responsibilities: responsibilityStore,
        responsibilityTurn: responsibilityAnswerTurn,
      });
      const source = await sourceForCoordinationRun({
        ...payload.question,
        botId: questionConversationBot(payload.question),
        depth: 0,
      });
      if (source && outcome.replyText)
        await channelStore.recordActivity(
          await actorFor(payload.ownerUserId),
          source.channelId,
          {
            text: outcome.replyText,
            agentId: questionConversationBot(payload.question),
            at: new Date(),
          },
          { id: `person-response:${item.key}` },
        );
      if (source && outcome.replyText)
        await deliveryNotifications(
          {
            ownerUserId: payload.ownerUserId,
            channelId: source.channelId,
            agentId: questionConversationBot(payload.question),
            threadId: payload.question.threadId,
          },
          {
            id: `person-response:${item.key}`,
            text: outcome.replyText,
            kind: "reply",
          },
        );
      if (
        !(await approvalQueue.finish({
          kind: item.kind,
          key: item.key,
          owner: personResponseOwner,
        }))
      )
        throw new Error(
          "The question response lease was lost before completion.",
        );
    } catch (error) {
      await approvalQueue.release({
        kind: item.kind,
        key: item.key,
        owner: personResponseOwner,
        delayMs: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "person-response-error",
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 2_000);

/**
 * Delivering hops, on every replica.
 *
 * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
 * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
 * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
 * replica adds delivery capacity rather than contention.
 *
 * Only where the capability is switched on. A deployment with a depth cap of zero never has a hop to
 * deliver, and a loop polling for work that cannot exist is a query a second for nothing.
 */
/*
 * Both zeros switch the capability off, so both have to stop the loop.
 *
 * Gated on the depth alone, a deployment that set the fan-out cap to zero still swept every two
 * seconds for hops that can never be offered: roughly forty thousand claim transactions per replica
 * per day, for a feature it had turned off.
 */
/**
 * The queue's own wake-up, when handing work between Bots is switched on at all.
 *
 * Held at module scope so the shutdown below can give its connection back. Undefined on a
 * deployment with the capability off, which is a deployment that never started one.
 */
let workOfferedListener: WorkOfferedListener | undefined;

if (config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0) {
  const runner = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("handoff"),
    auditStore: bootAuditStore,
    /*
     * The signed statement of the run the addressed Bot is about to start, carrying how deep the
     * chain has gone. Minted here, where the key lives, and one deeper than the run that asked.
     */
    sign: (work, claim) =>
      signHandoffDeliveryRun(work, config.keyEncryptionKey, undefined, claim),
    delivery: createHandoffDelivery({
      /*
       * Built as the person, WITH THEIR ROLE. The desk resolved it to decide the hop was allowed; a
       * delivery that then rebuilt them as an ordinary user could not find the Bot the desk had just
       * agreed to, and the person was told it never answered.
       */
      agentFor: async ({ actorId, botId, fromBotId }) => {
        const actor = await actorFor(actorId).catch(() => null);
        if (!actor) {
          throw new Error(
            "who this is for could not be confirmed, so the Bot was not run",
          );
        }
        return copilotRuntime.agentFor({
          actor,
          botId,
          initiator: { kind: "handoff", id: fromBotId },
        });
      },
      history: copilotRuntime.history,
      lock: copilotRuntime.threadLock,
      /*
       * A scratch thread of the addressed Bot's own, one per hop.
       *
       * An Intelligence thread has exactly one agent, so a second Bot cannot answer inside the first
       * Bot's conversation however it asks. Its turn runs here instead, unmapped to any channel, and
       * what it said comes back to the conversation that asked through the relay — in the asking
       * Bot's voice, which is the only voice that thread admits. Minted with the deployment's own
       * identity, like every thread this deployment starts.
       */
      mintThreadId: () => threadIdentity.mint(),
      /*
       * The roster, told that a relayed answer landed. The delivery knows only the thread it ran
       * in; this resolves which channel shows that thread — a scratch thread maps to nothing and
       * announces nowhere, which is the point of a scratch thread.
       */
      announce: async (input) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, input.threadId))
          .limit(1);
        // A Bot's group thread maps to no channel; its answer goes to the shared transcript.
        if (!mapped) {
          await groupConversations.announceHandoff(input);
          return;
        }
        const actor = await actorFor(input.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text: input.text,
          agentId: input.agentId,
          at: new Date(),
        });
      },
      // The asking conversation shown as working while a hop runs in it. Keyed by thread, resolved
      // to its channel by the store; a scratch thread maps to none and signals nowhere.
      setBusy: (input) => channelStore.signalBusy(input.threadId, input.busy),
      newRunId: () => randomUUID(),
      // The same address and the same token the runtime uses. Assembling either from configuration
      // produced a runner every join was refused for, because the thread's active run is a lock the
      // platform issues rather than something an API key can claim.
      runner: new IntelligenceAgentRunner(
        copilotRuntime.runnerConnection(),
      ) as never,
    }),
  });

  const sweep = async () => {
    try {
      const report = await runner.sweep();
      if (report.delivered.length > 0 || report.skipped.length > 0) {
        console.info(JSON.stringify({ type: "bot-handoff", ...report }));
      }
    } catch (error) {
      // A sweep that failed must not take the loop with it: the next one may find the database back.
      console.warn(
        "[handoff] a sweep could not run:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  /*
   * ONE SWEEP AT A TIME ON THIS REPLICA, from both callers below. A sweep poked while one is
   * running is remembered rather than started, and runs once the current one ends — a wake-up
   * that arrived mid-sweep may be for a hop the running sweep's claim already missed.
   */
  let sweeping = false;
  let sweepAgain = false;
  const kick = async () => {
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepAgain = false;
        await sweep();
      } while (sweepAgain);
    } finally {
      sweeping = false;
    }
  };

  /*
   * Woken by the queue itself, from any replica: a person is waiting through every hop, and the
   * poll below would spend up to two seconds per leg doing nothing. The poll stays as the
   * backstop — a notification is a latency optimisation, and one lost in transit costs one
   * interval, never the work. See repeatAfterEach for why an interval must not be used: an
   * interval would start another sweep every two seconds while a five-minute delivery runs, each
   * claiming a different batch, and this replica's concurrent agent runs would grow with the
   * backlog rather than stopping at the limit it was asked for.
   */
  workOfferedListener = await startWorkOfferedListener(
    config.databaseUrl,
    (kind) => {
      if (kind === HANDOFF_KIND) void kick();
    },
  );
  repeatAfterEach(kick, 2_000);
}

/*
 * And dropping the hops that are over, whether or not the capability is switched on.
 *
 * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
 * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
 * of the queue: switched back on a month later, the first thing that happens is a month-old question
 * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
 * past rather than part of the feature.
 *
 * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
 * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
 */
const reaper = createHandoffRunner({
  queue: createWorkQueue(database),
  owner: workOwner("reaper"),
  sign: () => "",
  auditStore: bootAuditStore,
  // Never called: `reap` deletes rows by age and claims nothing.
  delivery: {
    deliver: async () => {
      throw new Error("the reaper does not deliver hops");
    },
  },
});
repeatAfterEach(
  async () => {
    try {
      const purged = await reaper.reap();
      if (purged > 0) {
        console.info(JSON.stringify({ type: "bot-handoff-reaped", purged }));
      }
    } catch (error) {
      console.warn(
        "[handoff] hops that are over could not be dropped:",
        error instanceof Error ? error.message : error,
      );
    }
  },
  60 * 60 * 1_000,
);

/*
 * Naming conversations, in the API process rather than `worker/`, which the single-image container
 * does not run. Its own loop, so a slow model never delays a hop.
 */
const channelSummaries = {
  database,
  queue: createWorkQueue(database),
  transcript: routineIntelligence,
  title: createChannelTitler({
    model: runtimeModel.defaultModel,
    resolveApiKey: resolveRuntimeModelApiKey,
  }),
  owner: workOwner("summariser"),
};
repeatAfterEach(async () => {
  try {
    await offerChannelsAwaitingSummary(channelSummaries);
    const report = await summariseClaimedChannels(channelSummaries);
    if (report.written.length > 0) {
      console.info(
        JSON.stringify({ type: "channel-summaries", written: report.written }),
      );
    }
    // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
    await forgetSettledSummaries(channelSummaries);
  } catch (error) {
    // Never fatal, and never loud enough to drown the log: a deployment with no model configured
    // reaches this on every pass, and it has not gone wrong, it simply has no titles.
    console.warn(
      "[channels] conversations could not be named:",
      error instanceof Error ? error.message : error,
    );
  }
}, 10_000);

/*
 * Enterprise controls (server/src/admin): capability switches, SSO-required, SCIM offboarding,
 * computer termination, network policy push, Action Recording, the model allowlist and the
 * OpenTelemetry/SIEM export of the audit trail. Installed before the app so the computer boundary,
 * the HTTP gate and the guarded stores below all see it from the first request.
 */
await installEnterpriseControls({
  database,
  databaseUrl: config.databaseUrl,
  auditStore: bootAuditStore,
  ...(computerProvider ? { provider: computerProvider } : {}),
  ...(config.computer?.token ? { computerToken: config.computer.token } : {}),
  builtInModel: `${runtimeModel.provider}/${runtimeModel.defaultModel}`,
  people: peopleStore,
  initialAdminEmails: config.auth?.initialAdminEmails ?? [],
});
guardDeliveryStore(
  deliveryStore,
  bootAuditStore,
  (message) => new DeliveryRefusedError(message),
);
guardHostAccess(
  hostAccessBroker,
  (message) => new HostAccessRefusedError(message),
);
auditRoutineStore(routineStore, bootAuditStore);

const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  // The runtime call: the model, per-actor agent loading, and the two identity
  // functions are how a run is attributed to a person.
  copilotRuntime.handler,
  // The only path to an acting call.
  computerGateway,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // Who has signed in, and what an administrator may do about them.
  peopleStore,
  // The enterprise identity providers registered here. Read as facts about the deployment rather
  // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
  identityProviderStore,
  // Chooses the coworker for an untagged message, on the deployment's own model and key.
  intentRouter,
  // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
  pageFrameStore,
  // What a due routine actually does: a turn, run as its owner, into the thread they will open.
  routineRunner,
  // A person's own standing instructions: the list, and a switch to stop one.
  routineStore,
  // Where each person is in first-run onboarding, read by /api/me and written by the wizard.
  createOnboardingStore(database),
  // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
  // and the prompt their coworker is built from can never be two different pieces of text.
  userInstructionsStore,
  // The same database every other store here is built from, so a channel's staged and sent files
  // live behind the same connection as the messages that reference them.
  database,
  // Native host-folder sessions are session-only: grants disappear with this server process and the
  // desktop worker must authenticate with a fresh token for this run.
  hostAccessBroker,
  process.env.OPENBOT_DESKTOP_HOST_TOKEN,
  async (input) => {
    const proactiveRefusal = await guardProactiveCallback(
      input,
      proactiveReadOnlyRefs,
    );
    if (proactiveRefusal) return proactiveRefusal;
    const coordinated = await coordination.call(input);
    if (coordinated) return coordinated;
    const followUp = wakeUpTools({
      store: wakeUpStore,
      ownerUserId: input.actorId,
      agentId: input.botId,
      ...(input.initiator ? { initiator: input.initiator } : {}),
    }).find((candidate) => candidate.name === input.name);
    if (followUp) {
      const text = await followUp.execute(input.args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    const { name, args, botId, actorId, initiator } = input;
    const memory = memoryTools({
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }).find((candidate) => candidate.name === name);
    if (memory) {
      const text = await memory.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    }
    if (!name.startsWith("host_")) return null;
    const tool = hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      ...(initiator ? { initiator } : {}),
    }).find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        text: `${REFUSAL_MARKER} That host tool is not available for this Bot right now.`,
        isError: true,
      };
    }
    const text = await tool.execute(args);
    return { text, isError: text.startsWith(REFUSAL_MARKER) };
  },
  // The app directory, behind the same client the plugin store and the transport already share.
  // Absent without a key, which leaves the routes reporting no broker rather than listing apps
  // nobody could connect.
  composio ? { broker: composio.broker } : undefined,
  process.env.OPENBOT_MODEL_OAUTH_FILE?.trim()
    ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim())
    : undefined,
  createUserPreferencesStore(database),
  {
    store: createVoiceSessionStore(database, channelStore),
    summarize: createVoiceSummarizer({
      model: runtimeModel,
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
    channels: channelStore,
  },
  {
    store: learningSettings,
    status: copilotRuntime.learning?.status,
    inspect: copilotRuntime.learning?.inspect,
  },
  {
    approvals: approvalService,
    ...(signInService ? { passwords: signInService } : {}),
    demonstrations: {
      store: demonstrationStore,
      recorder: demonstrationRecorder,
    },
    delivery: {
      authenticated: {
        store: deliveryStore,
        router: deliveryRouter,
        scopeFor: deliveryScopeFor,
        listConversations: async (owner, cursor) =>
          channelStore.list(await actorFor(owner), { cursor, limit: 100 }),
        history: (scope) =>
          routineIntelligence.getThreadMessages({
            threadId: scope.threadId,
            userId: scope.ownerUserId,
          }),
        slack: deliveryProviders.slack,
        twilio: deliveryProviders.sms,
        pushProjectId: deliveryProviders.pushProjectId,
      },
      webhooks: {
        store: deliveryStore,
        router: deliveryRouter,
        approvals: approvalService,
        scopeFor: deliveryScopeFor,
        slack: deliveryProviders.slack,
        twilio: deliveryProviders.sms,
      },
    },
    memory: { store: personalMemoryStore, ingestion: memoryIngestion },
    proactive: { store: proactiveStore, engine: proactiveEngine },
    responsibilities: {
      store: responsibilityStore,
      engine: responsibilityEngine,
      bindings: responsibilityBindings,
      triggers: responsibilityTriggers,
    },
    groups: groupConversations,
    teamBots,
    lifecycle: {
      lifecycle: createBotLifecycleStore(database),
      reset: createBotReset({
        database,
        softDeleteChannel: (actor, channelId) =>
          channelStore.softDelete(actor, channelId),
      }),
      activity: createActivityStore(database),
      wakeUps: wakeUpStore,
      profiles: agentProfileStore,
      auditStore: bootAuditStore,
    },
  },
);

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  ownerUserId: string;
  botId: string;
  recordingId?: string;
  inward?: WebSocket;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: the app proxies
 * the computer stream, and it pushes channel activity through Hono's adapter. So this one
 * dispatches on what the upgrade attached, a proxy socket carries `upstream`, a Hono socket does
 * not, rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/api/audio/transcriptions") {
      server.timeout(request, DICTATION_HTTP_IDLE_SECONDS);
    }
    if (url.pathname === "/api/voice/calls") server.timeout(request, 30);
    if (url.pathname === "/api/voice/sessions") server.timeout(request, 30);
    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await resolveRequestActor(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // And which Bot, which the guard above does not answer. This socket carries that Bot's screen,
      // so signing in is not enough: without this, anybody signed in watches anybody's Bot work. And
      // seeing a Team Bot is not enough either: its screen is its owner's signed-in browser.
      if (
        !(await computerAccessCheck(agentProfileStore)(
          { id: actor.id, role: actor.role },
          streamBotId,
        ))
      ) {
        return new Response("There is no such Bot.", { status: 404 });
      }
      /*
       * Through the gateway, not the provider.
       *
       * `gateway.locate` runs checkComputerAddress; `provider.locate` does not, and the URL built
       * below carries COMPUTER_TOKEN in its query string. A provider that answered with a foreign
       * host was handed the deployment's computer token, which is the case that check was written
       * for. Every acting path already went through the gateway; this one did not.
       */
      let upstream: string;
      try {
        const streamBase = computerGateway
          ? await computerGateway.locate(streamBotId)
          : undefined;
        if (!streamBase) {
          return new Response("No computer address is configured.", {
            status: 503,
          });
        }
        upstream = toStreamUrl(streamBase, streamBotId);
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      const recording = await demonstrationStore.active(actor.id, streamBotId);
      if (recording)
        upstream += `&recording=${encodeURIComponent(recording.id)}`;
      if (
        server.upgrade(request, {
          data: {
            upstream,
            ownerUserId: actor.id,
            botId: streamBotId,
            ...(recording ? { recordingId: recording.id } : {}),
          },
        })
      ) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
  websocket: {
    open(ws) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const stream = ws.data;
      const inward = new WebSocket(stream.upstream);
      stream.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        if (stream.recordingId) {
          let recorded: unknown;
          try {
            recorded = JSON.parse(String(event.data));
          } catch {
            recorded = null;
          }
          if (
            recorded &&
            typeof recorded === "object" &&
            "type" in recorded &&
            recorded.type === "demonstration.action"
          ) {
            const data = stream;
            const message = recorded as {
              recordingId?: unknown;
              action?: unknown;
            };
            if (message.recordingId !== data.recordingId) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error:
                    "The recording identity changed. Stop and restart recording.",
                }),
              );
              return;
            }
            demonstrationRecorder
              .capture(
                data.ownerUserId,
                data.botId,
                data.recordingId ?? "",
                message.action,
              )
              .catch((error) => {
                console.error(
                  JSON.stringify({
                    type: "demonstration-capture-error",
                    error: error instanceof Error ? error.name : "UnknownError",
                    context: { recordingId: data.recordingId },
                    timestamp: new Date().toISOString(),
                  }),
                );
                try {
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      error:
                        "A browser step could not be saved. Stop and review the demonstration before continuing.",
                    }),
                  );
                } catch {
                  /* A closed viewer cannot receive the already logged failure. */
                }
              });
            return;
          }
        }
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
  },
});

if (config.singleUser) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "No identity provider is configured, so every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Configure GOOGLE_OAUTH_*, ` +
      "MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.",
  );
}

// Each listener holds a connection of its own for the life of the process. Released on the way out,
// so a watch-mode restart does not leave two behind on every reload.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    responsibilitySweep.stop();
    wakeUpSweep.stop();
    wakeUpReaper.stop();
    memorySweep.stop();
    proactiveSweep.stop();
    approvalSweep.stop();
    personResponseSweep.stop();
    groupSweep.stop();
    for (const sweep of deliverySweeps) sweep.stop();
    void Promise.allSettled([
      channelActivityListener.stop(),
      policyListener.stop(),
      // Started only where handing work between Bots is switched on, so it is often not there.
      workOfferedListener?.stop() ?? Promise.resolve(),
      Promise.resolve(retentionSweeps.stop()),
    ]).finally(() => process.exit(0));
  });
}

console.info(`OpenBot server listening on http://127.0.0.1:${port}`);
