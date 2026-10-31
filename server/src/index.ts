import type { AbstractAgent } from "@ag-ui/client";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { computerGuidance } from "@openbot/shared/bot-prompt";
import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import { workOwner } from "@openbot/shared/work-owner";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { createActivityStore } from "./activity/activity";
import {
  auditRoutineStore,
  enterpriseControls,
  guardDeliveryStore,
  guardHostAccess,
  installEnterpriseControls,
  skillSharingAllowed,
  skillSharingInSnapshot,
} from "./admin/controls";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "./agents/agent-resolver";
import {
  mintRunAssertion,
  type RunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
} from "./agents/callback-token";
import { canUseComputer } from "./agents/computer-access";
import { wireCoordination } from "./agents/coordination-wiring";
import { createAgentFetch } from "./agents/endpoint";
import { createHandoffDesk } from "./agents/handoff";
import { createHandoffRunner } from "./agents/handoff-runner";
import { startHandoffDelivery } from "./agents/handoff-wiring";
import { runsIsolated } from "./agents/isolation";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
} from "./agents/lifecycle";
import { createBotReset } from "./agents/lifecycle-reset";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { serverTurnAdmission } from "./agents/turn-admission";
import {
  createWakeUpRunner,
  createWakeUpStore,
  wakeUpTools,
} from "./agents/wake-up";
import { createApp } from "./app";
import { createApprovedActionExecutor } from "./approvals/execute";
import { createPersonResponseTick } from "./approvals/person-response-sweep";
import {
  type PersonQuestion,
  questionConversationBot,
} from "./approvals/questions";
import { createApprovalResumeTick } from "./approvals/resume-sweep";
import { createApprovalStore } from "./approvals/store";
import { ApprovalRefusedError } from "./approvals/types";
import { createServerApprovalService } from "./approvals/wiring";
import {
  type AuditInitiator,
  auditSink,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
} from "./audit";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth, sessionLifetimeMs } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import type { AuthService } from "./auth/guards";
import { createRoleRepository } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { createOrganizationAuth } from "./auth/organization";
import { organizationUserStore } from "./auth/organization-store";
import { openbotAddress } from "./browser/address";
import { botBrowserNetwork } from "./browser/bot-browser";
import { personBrowserEgressPolicy } from "./browser/egress";
import {
  botRecordRefusal,
  directBrowserComputers,
  gatewayBrowserComputers,
  personBrowserPlace,
  withPersonBrowsers,
} from "./browser/host";
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
import { type ChannelStore, createChannelStore } from "./channels/routes";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { headlessComponentCatalog } from "./components/headless";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import {
  botOwnership,
  createComputerSeatResolver,
} from "./computer/computer-key";
import { createComputerGateway } from "./computer/gateway";
import { createHeadlessComputerTools } from "./computer/headless-tools";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import {
  pushEgressPolicy,
  withPolicyPushOnWake,
} from "./computer/policy-network";
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
  chooseOpenAIApi,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
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
  brokeredConnections,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "./db/schema";
import { createDeliveryRouter, DELIVERY_WORK_KINDS } from "./delivery/router";
import {
  configuredDeliveryProviders,
  type DeliveryScopeResolver,
} from "./delivery/routes";
import { createDeliveryStore } from "./delivery/store";
import type { DeliveryScope } from "./delivery/types";
import { DeliveryRefusedError } from "./delivery/types";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { startHttpServer } from "./http-server";
import { githubCallbackRoutes } from "./identity/github-callback";
import { retireIdentityLinks, retireOwnedAccounts } from "./identity/retire";
import { slackCodeRedeemer } from "./identity/slack-redeem";
import { createIdentityStore } from "./identity/store";
import {
  createIntelligenceClient,
  observeIntelligenceAuthentication,
} from "./intelligence-client";
import { reportIntelligenceEntitlement } from "./intelligence-entitlement-check";
import {
  createLearningAutoAssign,
  probeLearningContainer,
  withLearningAutoAssign,
} from "./learning/auto-assign";
import {
  cliLoginPresent,
  createLearningContainer,
  ensureLearningContainer,
  intelligenceApiOrigin,
  keyIntelligence,
  type LearningContainerCredentials,
  learningSetupInstructions,
} from "./learning/ensure-container";
import {
  createPersonalLearningSpaces,
  createPersonSpaceStore,
} from "./learning/personal-space";
import { clearLearningRevisionFallback } from "./learning/runtime";
import { createLearningSettingsStore } from "./learning/settings";
import {
  createLearningSharingStore,
  createOpenSkillIndex,
} from "./learning/sharing";
import { createMemoryDefaults } from "./memory/defaults";
import { createMemoryIngestion } from "./memory/ingestion";
import { createIntelligenceMemory } from "./memory/intelligence";
import { createMemoryStore } from "./memory/store";
import { memoryTools } from "./memory/tools";
import { reportModelAvailability } from "./model-availability-check";
import { createSignInNotifier, createSignInResumer } from "./passwords/resume";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createOnboardingStore } from "./people/onboarding";
import { createProfileStore } from "./people/profile";
import { createPeopleStore } from "./people/store";
import { BROKERED_PROFILE } from "./plugins/access";
import { createAccountModeSwitch } from "./plugins/account-mode";
import { appAccessTools } from "./plugins/app-access-tool";
import { useArcadeClient } from "./plugins/arcade";
import { createArcadeClient } from "./plugins/arcade-adapter";
import { assertActivatable, providerDecision } from "./plugins/broker";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useComposioClient } from "./plugins/composio";
import { createComposioClient } from "./plugins/composio-adapter";
import { backfillBrokeredLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import {
  arcadeVerifierNotice,
  selectProviderWiring,
  storedProvider,
} from "./plugins/provider-wiring";
import {
  createSharedUseGate,
  createSharedUseStore,
} from "./plugins/shared-use-store";
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
import { createRecorderExtension } from "./recorder/wiring";
import { createRequestActor } from "./request-actor";
import { createResponsibilityBindingStore } from "./responsibilities/bindings";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  fetchText as fetchSnsText,
  inboundEmailConfigFromEnv,
} from "./responsibilities/email";
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
import { createServerResponsibilityEngine } from "./responsibilities/wiring";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import { createModelCompleter } from "./routing/model";
import { createSelfHostBanner } from "./self-host-banner";
import { createTeamBots } from "./team-bots/team-bots";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { createVoiceSessionStore } from "./voice/sessions";
import { createVoiceSummarizer } from "./voice/summary";
import { repeatAfterEach } from "./work/loop";
import { createWorkQueue, type WorkOfferedListener } from "./work/queue";

const config = loadConfig();
// The environment seeds local policy once. The SDK fallback must not reapply an old revision
// after an administrator clears a pin to follow the latest published Skills.
clearLearningRevisionFallback();
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const database = createDatabase(config.databaseUrl);
const profileStore = createProfileStore(database);
// Every dispatch point asks this database whether its person paused the Bot. See agents/lifecycle.ts.
configureBotLifecycle({ database });
const learningSettingsStore = createLearningSettingsStore(
  database,
  config.learning,
);
// Its own client, like the self-host banner's: the constructor opens nothing.
const learningProbeIntelligence = createIntelligenceClient(
  config.runtime.intelligence,
);
/*
 * Who can create the `openbot` container here: never the runtime key. A service token the operator
 * configured (local evaluation installs), or a CopilotKit CLI login on this machine, which is what a
 * laptop running `bun run start` has. Neither, and the log and Admin say exactly what to run instead.
 */
const learningApiOrigin = (() => {
  try {
    return intelligenceApiOrigin(config.runtime.intelligence.apiUrl);
  } catch {
    return undefined;
  }
})();
const learningCanCreate =
  learningApiOrigin !== undefined &&
  (config.learningSetup !== undefined || cliLoginPresent());
/** The credential that can create a Learning container, for the `openbot` default and for each person's own space. */
const learningCredentials = (apiUrl: string): LearningContainerCredentials => ({
  directory: process.cwd(),
  apiUrl,
  nonInteractive: true,
  key: keyIntelligence(
    apiUrl,
    config.runtime.intelligence.apiKey,
    config.runtime.intelligence.gatewayWsUrl,
  ),
  cliLogin: cliLoginPresent(),
  ...(config.learningSetup
    ? {
        serviceToken: {
          token: config.learningSetup.serviceToken,
          projectId: config.learningSetup.projectId,
        },
      }
    : {}),
});
const learningAutoAssign = createLearningAutoAssign({
  enabled: config.learningAutoAssign,
  store: learningSettingsStore,
  probe: (containerId) =>
    probeLearningContainer(learningProbeIntelligence, containerId),
  ...(learningApiOrigin
    ? { instructions: learningSetupInstructions(learningApiOrigin) }
    : {}),
  ...(learningCanCreate && learningApiOrigin
    ? {
        create: () =>
          ensureLearningContainer(learningCredentials(learningApiOrigin)),
      }
    : {}),
  audit: createAuditStore(database),
});
/*
 * Each person's own Learning space: every recording they make joins it, and every Bot they run uses its Skills. Made
 * with the same credential as the default container, on first need: when their browser connects, and again on a
 * capture pass if it is still missing. With no such credential a missing space cannot be made, and the Recorder says so.
 */
const personalLearningSpaces = createPersonalLearningSpaces({
  readSettings: () => learningSettingsStore.read(),
  snapshots: learningProbeIntelligence,
  store: createPersonSpaceStore(database),
  ...(learningCanCreate && learningApiOrigin
    ? {
        create: (container) =>
          createLearningContainer({
            ...learningCredentials(learningApiOrigin),
            container,
          }),
      }
    : {}),
  nameFor: async (userId) =>
    (
      await database
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    ).map((row) => row.name?.trim() || null)[0] ?? null,
});
const learningSharingStore = createLearningSharingStore(database);
/** What everyone opened to every Bot, in memory: runs read this, never each person's space or the table. */
const openSkillIndex = createOpenSkillIndex({
  read: () => learningSharingStore.openSources(),
});
const learningSettings = withLearningAutoAssign(
  learningSettingsStore,
  learningAutoAssign,
);
learningAutoAssign.start();
await initializeDevActorUser(database, config.singleUser);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const identityStore = createIdentityStore(database, credentialStore);
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
const baseChannelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
);
/**
 * A person spoke in one of their conversations. Bound once memory defaults exist (memory/defaults.ts):
 * a conversation with one Bot switches on that Bot's research and memory sources for this person.
 */
let personSpoke: ((ownerUserId: string, channelId: string) => void) | undefined;
const channelStore: ChannelStore = {
  ...baseChannelStore,
  async recordActivity(actor, channelId, activity, source) {
    await baseChannelStore.recordActivity(actor, channelId, activity, source);
    if (activity.agentId === null) personSpoke?.(actor.id, channelId);
  },
};
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
   * Removing somebody retires what they connected: their plugin credentials and connections, and
   * their linked outside accounts (which keep resolving to them, now refused; the tokens are revoked
   * and every link needs reconnecting). Both halves run whichever fails, and the failure is rethrown
   * after (see retireOwnedAccounts).
   *
   * A closure, because `pluginStore` is built further down: this has to exist before `auth` does,
   * and that one needs the vault and the policy. `pluginStore` is read only when the closure runs —
   * an administrator or the directory removing somebody, never during module initialisation — so by
   * then the binding is there. The linked-account half writes its audit rows through a store made
   * on its own transaction, so it reads no later binding (`bootAuditStore` included).
   */
  (userId, by) =>
    retireOwnedAccounts({
      plugins: () => pluginStore.retireConnectionsFor(userId, by),
      identities: () =>
        retireIdentityLinks(
          database,
          credentialStore,
          (executor) => createAuditStore(executor),
          userId,
          by,
        ),
      // Removing somebody ends their sessions, so it ends their browsers' Recorders too.
      recorders: () => signOutRecorders(userId, "person_removed"),
    }),
);
const identityProviderStore = createIdentityProviderStore(database);
/*
 * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
 * store that receives those rows has to exist before anything can sign in.
 */
const signInAuditStore = createAuditStore(database);
/*
 * A person's sign-in ending here ends their browsers' Recorders with it, however it ends: they sign out, their sessions
 * are ended (by them, an administrator, the directory, the identity provider), or they are removed. Retried, and when it
 * still fails the sign-in does not end either (recorder/sign-out.ts). Called only once something ends, which comes after
 * the Recorder's wiring below exists.
 */
const signOutRecorders = (userId: string, ending: string) =>
  recorderExtension.signOut(userId, ending);
// Its own const so the Recorder can re-check a stored session through `verifySessionQuietly`.
const organizationAuth = config.organizationAuthUrl
  ? createOrganizationAuth({
      authorityUrl: config.organizationAuthUrl,
      materializeUser: organizationUserStore(database),
      signOutRecorders,
    })
  : undefined;
// Its own const so the Recorder's connections can last as long as one of its sessions does.
const betterAuth =
  !organizationAuth && config.auth
    ? createAuth(
        config,
        database,
        (email) => peopleStore.isRevoked(email),
        signInAuditStore,
        { signOutRecorders },
      )
    : undefined;
const auth: AuthService | undefined = organizationAuth ?? betterAuth;
const { resolveRequestActor, identifyUser, identifyActor } = createRequestActor(
  {
    singleUser: config.singleUser,
    // Answered only on the capture pass. Called per request, after the Recorder's wiring below exists.
    resolveRecorder: (request) => recorderExtension.resolve(request),
    getSession: async (headers) =>
      (await auth?.api.getSession({ headers })) ?? null,
    rolesForUser: (id) => roleRepository.rolesForUser(id),
  },
);
// Where a person's own OpenBot browser may go: not where Bots may, but where their browser on their own laptop would
// (browser/egress.ts). On OpenBot Desktop's host-side computer that is their own desktop, so everywhere.
const personBrowserPolicy = personBrowserEgressPolicy({
  native: config.browser !== undefined,
  allowPrivateHosts: config.computer?.allowPrivateHosts ?? false,
  openbotUrls: [config.publicUrl, config.appUrl],
  gatewayUrl: config.runtime.intelligence.gatewayWsUrl,
});
// Each computer is pushed its network policy on the way to the action that woke it, because a
// computer refuses every connection until one arrives (see `withPolicyPushOnWake`). A person's own
// browser is found where it runs (OPENBOT_BROWSER_URL, else the same provider) and pushed theirs.
const computerProvider = config.computer
  ? withPolicyPushOnWake(
      withPersonBrowsers(
        createComputerProvider(config.computer),
        config.browser?.url,
      ),
      {
        policyForBot: (botId) =>
          isPersonBrowserId(botId)
            ? Promise.resolve(personBrowserPolicy)
            : enterpriseControls()?.policyForBot(botId),
        ...(config.computer.token ? { token: config.computer.token } : {}),
        ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
      },
    )
  : undefined;

/** Why Record is refused in a Bot's browser here, or undefined where each Bot has a computer of its own. */
const recordRefused = botRecordRefusal(computerProvider) ?? undefined;

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
// The gallery every headless turn offers its Bot, refusals written to the same trail.
const componentCatalog = headlessComponentCatalog({
  store: componentStore,
  audit: auditSink(bootAuditStore),
});
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

/*
 * A run's source conversation: a channel's own thread, or a Bot's thread in a group conversation.
 * The group lookup applies the same live-membership and own-Bot checks. See channels/group.ts.
 */
const sourceForCoordinationRun = async (run: RunAssertion) =>
  (await channelSourceForRun(run)) ?? groupSourceForRun(database, run);

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
// Before anything reads the model environment: blank base URLs removed, Anthropic given its `/v1`.
normalizeModelBaseUrls();
const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);
// And before any Bot's model is resolved: behind a gateway, the API that model takes tools on (chooseOpenAIApi).
if (chooseOpenAIApi(runtimeModel) === "responses")
  console.info(
    JSON.stringify({
      type: "openai-api",
      api: "responses",
      model: runtimeModel.defaultModel,
      message: `${runtimeModel.defaultModel} takes tools only through the Responses API, so the built-in Bots call /responses at OPENAI_BASE_URL. Set COPILOTKIT_OPENAI_API=chat to call /chat/completions instead.`,
    }),
  );

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
 * already-running check that keeps two turns off one thread. See `toolkit/run-turn.ts`.
 */
const routineIntelligence = observeIntelligenceAuthentication(
  new CopilotKitIntelligence({
    apiUrl: config.runtime.intelligence.apiUrl,
    wsUrl: config.runtime.intelligence.gatewayWsUrl,
    apiKey: config.runtime.intelligence.apiKey,
  }),
);
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
        seat: await computerGateway.seatFor(agentId, actor.id),
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
      })
    : [];
};

const approvalService = createServerApprovalService({
  storedApprovals,
  config,
  sourceForCoordinationRun,
  agentProfileStore,
  actorFor,
  database,
  authoriseQuestion,
  routineIntelligence,
  approvalComputerTools,
  review: (prompt, signal) => chooseSkills(prompt, signal),
  // Assigned further down, once delivery is wired.
  notify: (scope, input) => deliveryNotifications(scope, input),
});
// Housekeeping on a schedule: audit rows when asked for, screenshots always, one timer. See audit-retention.ts.
const retentionSweeps = startRetentionSweeps(
  config.databaseUrl,
  config.auditRetentionDays,
  pageFrameStore,
);
/**
 * Whose computer a Bot runs on: the person it acts for, unless the Bot is isolated and its owner
 * still holds the switch (`runsIsolated`, agents/isolation.ts). A provider that cannot make a
 * computer for one Bot (the one shared computer) gives every Bot a seat for the person instead.
 */
const computerSeats = computerProvider
  ? createComputerSeatResolver({
      runsIsolated: (botId) => runsIsolated(database, botId),
      bot: botOwnership(database),
      canIsolate: computerProvider.isolation === "per-person",
    })
  : undefined;

const computerGateway = computerProvider
  ? createComputerGateway({
      provider: computerProvider,
      ...(computerSeats ? { seats: computerSeats } : {}),
      // Who each person's computer belongs to, for the admin list.
      people: async (ids) =>
        new Map(
          (
            await database
              .select({ id: users.id, name: users.name, email: users.email })
              .from(users)
              .where(inArray(users.id, ids))
          ).map((row) => [row.id, { name: row.name, email: row.email }]),
        ),
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
/*
 * EXACTLY ONE PROVIDER, DECIDED ONCE. `selectProviderWiring` answers which transport client is
 * installed and which broker goes on to the store and the routes; the other client is installed as
 * an explicit `null`, so a deployment holding both keys (legal, and needed to end accounts at the
 * old vendor) never has two seams live. It refuses, rather than wiring nothing, both configurations
 * it cannot decide: a named provider whose key is unset, and both keys set with nothing named.
 */
const providerWiring = selectProviderWiring(config, {
  composio: createComposioClient,
  arcade: createArcadeClient,
});
useComposioClient(providerWiring.install.composio);
useArcadeClient(providerWiring.install.arcade);
const wiredProvider = providerWiring.provider;
const composio =
  wiredProvider && providerWiring.broker
    ? { broker: providerWiring.broker, provider: wiredProvider }
    : null;
/*
 * Activation is refused while the OTHER provider still holds connection rows. Keyed on rows, never
 * on keys: having both keys set is the expected state while the old provider's connections are ended.
 */
if (wiredProvider) {
  const [{ count: otherProviderRows }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(brokeredConnections)
    .where(ne(brokeredConnections.provider, wiredProvider));
  assertActivatable(wiredProvider, otherProviderRows);
}
/*
 * Arcade's verifier is set by hand in Arcade's dashboard and cannot be read back, so an Arcade
 * deployment says once, at startup, which address it must be set to. See `arcadeVerifierNotice`.
 */
if (wiredProvider === "arcade") {
  console.warn(arcadeVerifierNotice(config.publicUrl));
}

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

/*
 * Whether a Bot may act through a Shared app at all, kept apart from the policy boundary above
 * because it answers a different question: not "is this action allowed" but "is this Bot's
 * audience narrow enough for what an administrator approved for the shared account." Kept in
 * module scope because the publication, assignment and grant routes below also need to reapprove
 * or refile against it when a Bot's exposure changes.
 */
/*
 * WHICH SLICE of `brokered_connections` this deployment reads, decided ONCE, at the one boundary
 * that can see both the configuration and the rows.
 *
 * THERE IS NO `?? "composio"` HERE ANY MORE, AND THAT WAS A BUG RATHER THAN A SHORTHAND.
 * Configuration names no provider for three different reasons, and the one that matters is "both
 * keys set, OPENBOT_BROKER_PROVIDER unset" — legal, documented, and exactly what a deployment
 * migrating off Composio sits in while it ends its old accounts. Defaulting it to `composio` gave
 * the plugin store and the shared-use store a filter that excludes every Arcade row this deployment
 * holds, so live Arcade connections read as absent and the accounts behind them could not be
 * revoked. `storedProvider` takes the three causes apart and, where configuration is silent, lets
 * the rows name themselves. The shared-use store and the plugin store are both given this one
 * value, so the gate and the approvals it reads agree.
 */
const providerConfiguration = providerDecision(config);
const brokerProvider = storedProvider(
  providerConfiguration,
  (
    await database
      .selectDistinct({ provider: brokeredConnections.provider })
      .from(brokeredConnections)
  ).map((row) => row.provider),
);
if (providerConfiguration.kind === "ambiguous") {
  /*
   * Said out loud, once, at startup: this deployment has two keys and no answer, so nothing is
   * active and nothing can be connected or revoked until one is named. The rows it already holds
   * are read as their own provider's (above), which is why this is a warning and not a refusal —
   * the screens stay honest, the vendor calls stay impossible.
   */
  console.warn(
    `${providerConfiguration.configured.map((provider) => BROKERED_PROFILE[provider].envVar).join(" and ")} are both set and OPENBOT_BROKER_PROVIDER names neither, so no broker is active: connected apps can be neither connected nor revoked until it is set. Existing connections are read as ${BROKERED_PROFILE[brokerProvider].vendor}'s.`,
  );
}
const sharedUseStore = createSharedUseStore(database, brokerProvider);

const pluginStore = createPluginStore({
  database,
  deploymentId: config.deploymentId ?? tenantPackage.tenantId,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
  approvalGate: approvalService.gate,
  sharedUse: createSharedUseGate(sharedUseStore, bootAuditStore),
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
  brokerProvider,
});

/*
 * Personal ⇄ Shared for a brokered app. Built here because it needs the plugin store, the shared-use
 * store and the approval policy at once: making an app Shared ends people's accounts, approves each
 * Bot that holds it and adds an ask-before-write rule for its writes.
 */
const accountModes = createAccountModeSwitch({
  store: pluginStore,
  sharedUse: sharedUseStore,
  teamRules: approvalService.store.policy,
  deploymentId: config.deploymentId ?? tenantPackage.tenantId,
  audit: bootAuditStore,
});

// Logo metadata is optional; a vendor outage must not prevent the API from starting.
if (composio) {
  void backfillBrokeredLogos(
    database,
    composio.provider,
    composio.broker,
  ).catch(() => {
    console.warn(
      `${BROKERED_PROFILE[composio.provider].vendor} app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.`,
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
const deliveryStore = createDeliveryStore(database);

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
  // The asking conversation, told it is now waiting on the Bot it asked. See `onOffered`.
  onOffered: (threadId) => channelStore.signalWork(threadId),
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

// Said once at boot: whether the key can call the model the Bots run on. A key without access to it
// otherwise passes every start-up check and fails at the first message, in front of whoever sent it.
void reportModelAvailability({
  provider: runtimeModel.provider,
  model: runtimeModel.defaultModel,
  apiKey: () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    }),
});

// Named collaborators are bound once in actorAgentResolver for chat, hops, and headless turns.

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
// Memory lives in CopilotKit Intelligence when this deployment is entitled to it, and in OpenBot's own
// tables when it is not; see memory/store.ts. Its own client, like the thread reader's: the
// constructor opens nothing.
const personalMemoryStore = createMemoryStore(database, {
  intelligence: createIntelligenceMemory({
    client: createIntelligenceClient(config.runtime.intelligence),
  }),
});
const recorderExtension = createRecorderExtension({
  config,
  database,
  organizationAuth,
  roleRepository,
  peopleStore,
  personalSpaces: personalLearningSpaces,
  auditStore: bootAuditStore,
  ...(betterAuth
    ? { sessionLifetimeMs: await sessionLifetimeMs(betterAuth) }
    : {}),
  // A connection is made or ended exactly when its row is written: both in one transaction.
  auditFor: (executor) => createAuditStore(executor),
});
/*
 * Connections whose lifetime has run out already resolve to nobody; this ends them for good, with the sealed
 * organization session any of them still held, and writes their rows. Every replica runs it, and each row is ended once.
 */
const recorderExpirySweep = repeatAfterEach(async () => {
  try {
    await recorderExtension.connections.expire();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "recorder-expiry-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
const memoryIngestion = createMemoryIngestion({
  store: personalMemoryStore,
  plugins: pluginStore,
  canUseBot: async (owner, bot) =>
    (await pluginStore.agentOwner(bot)) === owner ||
    (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
});
// Proactive research may only read; see proactive/restriction.ts. Read from the catalogue per call.
const proactiveReadOnlyRefs = createReadOnlyClassifier(pluginStore);
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

/*
 * Memory sources and background research, on by default for each person and Bot, and never switched
 * back on once the person turns one down. See memory/defaults.ts.
 */
const memoryDefaults = createMemoryDefaults({
  database,
  ingestion: memoryIngestion,
  sources: config.memoryDefaults.sources,
  research: config.memoryDefaults.research,
  channelBots: async (ownerUserId, channelId) =>
    (await channelStore.get(await actorFor(ownerUserId), channelId))
      ?.agentIds ?? null,
  // The same rule research delivery uses, read when a person speaks (long after it is defined).
  canDeliver: async (ownerUserId, channelId, agentId) =>
    (await deliveryScopeFor(ownerUserId, channelId, agentId)) !== null,
  mintThreadId: () => threadIdentity.mint(),
  // Read when a Bot turn starts, long after `teamBots` below is defined.
  publishedByAnother: (ownerUserId, agentId) =>
    teamBots.publishedByAnother(ownerUserId, agentId),
});
personSpoke = memoryDefaults.personSpoke;
const loadPersonalMemoryForActor = (ownerUserId: string) => (botId: string) => {
  // Apps connected since this Bot's last turn become its memory sources. Never waits.
  memoryDefaults.botTurn(ownerUserId, botId);
  return memoryIngestion.contextFor(ownerUserId, botId);
};
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
  // Mirror to Intelligence what is out of step: the backfill on the first passes after a deployment
  // becomes entitled, and afterwards whatever an outage left behind. A no-op without Intelligence.
  try {
    await personalMemoryStore.mirrorPending();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "memory-sweep-error",
        error: error instanceof Error ? error.name : "UnknownError",
        context: { operation: "mirrorPending" },
        timestamp: new Date().toISOString(),
      }),
    );
  }
}, 60_000);
// Follow-ups a Bot schedules for itself, on the shared work queue. See agents/wake-up.ts.
const wakeUpStore = createWakeUpStore(database, { auditStore: bootAuditStore });

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
    /*
     * Held by every Bot, granted or not: how a Bot puts an app it cannot reach in front of the
     * person with the step that fixes it, instead of naming an administrator. A read; see the file.
     */
    ...appAccessTools({
      store: pluginStore,
      botId,
      actorId,
      composioConfigured: Boolean(composio),
      ...(composio ? { directory: () => composio.broker.listApps() } : {}),
      sharedAudience: sharedUseStore.admitsPerson,
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
const { coordination, coordinationForActor } = wireCoordination({
  handoffDesk,
  config,
  approvalService,
  agentProfileStore,
  actorFor,
  channelSourceForRun,
  database,
  pluginStore,
  bootAuditStore,
  peopleStore,
  sourceForCoordinationRun,
  channelStore,
  // Assigned further down, once delivery is wired.
  notify: (scope, input) => deliveryNotifications(scope, input),
});

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
  let agent: AbstractAgent | undefined;
  try {
    agent = await actorAgentResolver.resolveAgentForActor(actor, agentId, {
      initiator,
      depth,
    });
  } catch (error) {
    if (!(error instanceof CoworkerUnavailableError)) throw error;
  }
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
const routineAgentRunner = new IntelligenceAgentRunner({
  url: routineIntelligence.ɵgetRunnerWsUrl(),
  authToken: routineIntelligence.ɵgetRunnerAuthToken(),
});

const routineRunner = createRoutineRunner({
  routineStore,
  channelStore,
  runTurn: createTurnRunner({
    admission: serverTurnAdmission,
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: componentCatalog,
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
        seat: await computerGateway.seatFor(agentId, actor.id),
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
const actorAgentResolver = createActorAgentResolver({
  loadAgents: loadAgentsForActor,
  model: runtimeModel,
  resolveModelApiKey: resolveRuntimeModelApiKey,
  stallGuard,
  loadToolsForActor: (actorId, initiator) =>
    restrictToolsForRun(
      initiator,
      loadToolsForActor(actorId, initiator),
      proactiveReadOnlyRefs,
    ),
  signRunForActor,
  computerGuidance: config.computer ? computerGuidance : undefined,
  loadVendors,
  selectionForActor,
  agentFetch,
  handoffForActor: (actorId, initiator, depth) =>
    restrictCoordinationForRun(
      initiator,
      coordinationForActor(actorId, initiator, depth),
    ),
  loadInstructionsForActor,
  loadNameForActor: async (actorId) => {
    const profile = await profileStore.read(actorId);
    return profile.needsName ? null : profile.name;
  },
  loadAttachmentForActor,
  markAttachmentsSentForActor,
  // The runtime owns Learning. Resolve its reader only when a turn is built, after boot wiring.
  get acquireLearnedSkills() {
    return copilotRuntime.learning?.acquire;
  },
  loadPersonalMemoryForActor,
});

const copilotRuntime = mountCopilotRuntime(
  config,
  actorAgentResolver,
  identifyUser,
  identifyActor,
  {
    onRunBusy: (input) => {
      void channelStore.signalBusy(input.threadId, input.busy).catch(() => {});
    },
    learningSettings,
    personalSkills: {
      containerFor: personalLearningSpaces.containerFor,
      openSkills: () => openSkillIndex.sources(),
      sharingAllowed: skillSharingInSnapshot,
    },
    trajectoryCapture: recorderExtension.trajectoryCapture,
  },
);

const responsibilityEngine = createServerResponsibilityEngine({
  database,
  responsibilityStore,
  routineIntelligence,
  routineAgentRunner,
  componentCatalog,
  buildAgentFor,
  actorFor,
  computerGateway,
  agentProfileStore,
  bootAuditStore,
  signInService,
  copilotRuntime,
  channelStore,
  // Assigned further down, once delivery is wired.
  notify: (scope, input) => deliveryNotifications(scope, input),
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
    admission: serverTurnAdmission,
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: componentCatalog,
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
  admission: serverTurnAdmission,
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  components: componentCatalog,
  buildAgentFor,
  toolsForTurn: async ({ ownerUserId, agentId, initiator }) =>
    approvalComputerTools(ownerUserId, agentId, initiator),
  learningContainerForThread: (input) =>
    copilotRuntime.learning?.containerForThread(input) ??
    Promise.resolve(undefined),
});
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
    admission: serverTurnAdmission,
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: componentCatalog,
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
        seat: await computerGateway.seatFor(agentId, actor.id),
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

const approvalSweep = repeatAfterEach(
  createApprovalResumeTick({
    approvalQueue,
    approvalOwner,
    approvalService,
    executeApprovedAction,
    database,
    responsibilityStore,
    groupConversations,
    approvalContinuationRunner,
    channelStore,
    actorFor,
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
  }),
  2_000,
);
const deliveryProviders = configuredDeliveryProviders(
  config.publicUrl ?? config.auth?.baseUrl ?? `http://localhost:${config.port}`,
);
// Slack channel membership for triggers is answered by OpenTag, which holds the workspace token.
useSlackChannelMembership((input) =>
  deliveryProviders.slack
    ? deliveryProviders.slack.isMember(input)
    : Promise.resolve(false),
);
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
    admission: serverTurnAdmission,
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
    admission: serverTurnAdmission,
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: componentCatalog,
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
        seat: await computerGateway.seatFor(agentId, actor.id),
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

const personResponseSweep = repeatAfterEach(
  createPersonResponseTick({
    approvalQueue,
    personResponseOwner,
    authoriseQuestion,
    approvalContinuationRunner,
    responsibilityStore,
    responsibilityAnswerTurn,
    sourceForCoordinationRun,
    channelStore,
    actorFor,
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
  }),
  2_000,
);

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
  workOfferedListener = await startHandoffDelivery({
    config,
    database,
    bootAuditStore,
    actorFor,
    copilotRuntime,
    threadIdentity,
    groupConversations,
    channelStore,
  });
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
  personBrowserPolicy,
  // While a person records in a Bot's browser, the Recorder there reaches OpenBot and the gateway; the Bot does not.
  duringRecording: botBrowserNetwork({
    connections: recorderExtension.connections,
    openbotUrls: [config.publicUrl, config.appUrl],
    gatewayUrl: config.runtime.intelligence.gatewayWsUrl,
  }),
  ...(computerProvider ? { provider: computerProvider } : {}),
  ...(config.computer?.token ? { computerToken: config.computer.token } : {}),
  ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
  builtInModel: `${runtimeModel.provider}/${runtimeModel.defaultModel}`,
  people: peopleStore,
  initialAdminEmails: config.auth?.initialAdminEmails ?? [],
  recorders: {
    holders: () => recorderExtension.connections.holders(),
    signOut: signOutRecorders,
  },
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

// Asked only whether this deployment pays for Intelligence, for the self-host banner. Its own client
// rather than the runtime's, the same as the thread reader: the constructor opens nothing.
const selfHostBannerIntelligence = createIntelligenceClient(
  config.runtime.intelligence,
);

// Said once, at boot, whether Intelligence will let this deployment use what it is licensed for. A
// self-hosted Intelligence without a licence refuses memory quietly; this is the line that says why.
void reportIntelligenceEntitlement({
  entitlements: () => selfHostBannerIntelligence.getRuntimeEntitlements(),
});

const identityGithubCallback =
  config.githubApp && config.publicUrl
    ? githubCallbackRoutes({
        clientId: config.githubApp.clientId,
        clientSecret: config.githubApp.clientSecret,
        publicUrl: config.publicUrl,
        appUrl: config.appUrl,
        encryptionKey: config.keyEncryptionKey,
        personIsActive: async (userId) => {
          const person = await peopleStore.find(userId);
          return person !== undefined && !person.revoked;
        },
        credentials: credentialStore,
        identity: identityStore,
        auditStore: bootAuditStore,
      })
    : undefined;

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
  composio ?? undefined,
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
    autoAssign: learningAutoAssign,
    status: copilotRuntime.learning?.status,
    inspect: copilotRuntime.learning?.inspect,
  },
  {
    approvals: approvalService,
    shared: { modes: accountModes, use: sharedUseStore },
    ...(signInService ? { passwords: signInService } : {}),
    recorder: recorderExtension,
    // A Bot's browser, worked by the person holding its wheel: its bar and Record, wherever Bots have computers.
    ...(computerGateway
      ? {
          botBrowser: {
            recorder: recorderExtension,
            openbotUrl: openbotAddress(config),
            ...(config.computer?.token ? { token: config.computer.token } : {}),
            // The Bot's policy, which `botBrowserNetwork` widens while a recording runs, to the computer of the seat
            // the recording is on: the person's own, or the isolated Bot's.
            pushPolicy: async (seat) => {
              const policy = await enterpriseControls()?.policyForBot(
                seat.botId,
              );
              if (!policy) return;
              await pushEgressPolicy(
                await computerGateway.locate(seat),
                seat.botId,
                policy,
                {
                  ...(config.computer?.token
                    ? { token: config.computer.token }
                    : {}),
                  ...(config.webBotAuth
                    ? { webBotAuth: config.webBotAuth }
                    : {}),
                },
              );
            },
            singleUser: config.singleUser,
            // Where every Bot shares one computer, Record is refused in all their browsers (browser/host.ts).
            ...(recordRefused ? { recordRefused } : {}),
          },
        }
      : {}),
    // Only where a person's browser can run: OpenBot Desktop's host-side computer, or computers Bots run on that give
    // each its own. Where every Bot shares one, the routes have no computers and say why (browser/host.ts).
    ...(computerGateway || config.browser
      ? {
          browser: {
            ...personBrowserPlace({
              provider: computerProvider,
              browserUrl: config.browser?.url,
              ...(config.browserAbsent ? { absent: config.browserAbsent } : {}),
              computers: () =>
                computerGateway
                  ? gatewayBrowserComputers(
                      computerGateway,
                      config.browser?.url,
                    )
                  : directBrowserComputers({
                      browserUrl: (config.browser as { url: string }).url,
                      policy: personBrowserPolicy,
                      ...(config.browser?.token
                        ? { token: config.browser.token }
                        : {}),
                    }),
            }),
            ...((config.computer?.token ?? config.browser?.token)
              ? { token: config.computer?.token ?? config.browser?.token }
              : {}),
            recorder: recorderExtension,
            openbotUrl: openbotAddress(config),
            // On a single-user OpenBot the person is its admin: a setup failure is theirs to see to.
            singleUser: config.singleUser,
          },
        }
      : {}),
    personalLearning: {
      store: learningSharingStore,
      skillsOf: (userId) =>
        copilotRuntime.learning?.personalSkills(userId) ??
        Promise.resolve({ unavailable: "unavailable" as const }),
      invalidate: () => openSkillIndex.invalidate(),
      sharingAllowed: skillSharingAllowed,
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
        identity: slackCodeRedeemer(identityStore, bootAuditStore),
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
  createSelfHostBanner({
    enabled: config.selfHostBanner,
    entitlements: () => selfHostBannerIntelligence.getRuntimeEntitlements(),
  }),

  identityStore,
  identityGithubCallback,
  profileStore,
);

startHttpServer({
  port,
  config,
  resolveRequestActor,
  agentProfileStore,
  computerGateway,
  app,
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
    recorderExpirySweep.stop();
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
