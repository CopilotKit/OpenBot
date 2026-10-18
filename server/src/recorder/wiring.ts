import type {
  CopilotKitIntelligence,
  CopilotRuntimeHooks,
  GetTrajectoryLearningContainerIds,
} from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import { eq } from "drizzle-orm";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import type { AuthenticatedActor, RoleRepository } from "../auth/guards";
import { ORGANIZATION_SESSION_COOKIE } from "../auth/organization";
import type { DeploymentConfig } from "../config";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { PeopleStore } from "../people/store";
import type { PluginStore } from "../plugins/store";
import { createRecorderConnectionStore } from "./connections";
import { allowedExtensionIds } from "./extension-origins";
import {
  createRecorderResolver,
  type RecorderMode,
  type RecorderRefusalSink,
  type RecorderResolver,
} from "./guard";
import { createLearningSpaceCheck } from "./learning-space";
import { createRecorderRefusalAudit } from "./refusal-audit";
import type { RecorderRouteDeps } from "./routes";
import { createTrajectoryBindingStore } from "./trajectory-bindings";
import {
  createTrajectoryConnectHook,
  createTrajectoryLearningSelector,
  createTrajectoryRefusalAudit,
} from "./trajectory-gate";

/** What createApp's `coworker.recorder` takes. */
export type RecorderExtensionDeps = Omit<
  RecorderRouteDeps,
  "requireUser" | "requireRecorder" | "auditStore"
> & {
  resolve: RecorderResolver;
  onRefused: RecorderRefusalSink;
};

/** The value of one cookie in a Cookie header, or undefined. */
function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

/**
 * Every piece of Recorder wiring `index.ts` would otherwise hold, so tests build exactly what `index.ts` builds
 * (`index.ts` cannot be imported by a test: it loads the config and starts the server at top level).
 */
export function createRecorderExtension(deps: {
  config: DeploymentConfig;
  database: Database;
  organizationAuth:
    | {
        verifySessionQuietly(
          cookieHeader: string,
        ): Promise<AuthenticatedActor | null>;
      }
    | undefined;
  roleRepository: RoleRepository;
  peopleStore: Pick<PeopleStore, "isRevoked">;
  agentProfileStore: AgentProfileStore;
  pluginStore: Pick<PluginStore, "agentOwner">;
  actorFor(userId: string): Promise<AgentActor>;
  learningSettingsStore: { read(): Promise<LearningSettings> };
  /** The client the existing Learning container probe uses. */
  snapshots: Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot">;
  auditStore: AuditStore;
}): RecorderExtensionDeps & {
  /** Also the demonstration recorder's `ownsBot`, so there is one copy. */
  canRecordForBot(ownerUserId: string, botId: string): Promise<boolean>;
  /** The capture pass, for `mountCopilotRuntime`: its gate (an onBeforeHandler hook) and its Learning space selector. */
  trajectoryCapture: {
    gate: NonNullable<CopilotRuntimeHooks["onBeforeHandler"]>;
    selectLearningContainers: GetTrajectoryLearningContainerIds;
  };
} {
  const { config, database, organizationAuth } = deps;
  const connections = createRecorderConnectionStore(database);
  const trajectoryBindings = createTrajectoryBindingStore(database);

  const canRecordForBot = async (ownerUserId: string, botId: string) =>
    (await deps.pluginStore.agentOwner(botId)) === ownerUserId ||
    (await deps.agentProfileStore.get(
      await deps.actorFor(ownerUserId),
      botId,
    )) !== null;

  const mode: RecorderMode = config.singleUser
    ? { kind: "single-user" }
    : organizationAuth
      ? {
          kind: "organization",
          session: (cookie) => organizationAuth.verifySessionQuietly(cookie),
          unseal: (value) => decryptSecret(config.keyEncryptionKey, value),
        }
      : {
          kind: "better-auth",
          roles: deps.roleRepository,
          isRevoked: (email) => deps.peopleStore.isRevoked(email),
          allowedEmailDomains: config.auth?.allowedEmailDomains ?? [],
        };

  const userRow = async (userId: string) =>
    (
      await database
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          image: users.image,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0] ?? null;
  const resolve = createRecorderResolver({ connections, mode, user: userRow });

  const sealOrganizationSession: RecorderExtensionDeps["sealOrganizationSession"] =
    organizationAuth
      ? async (cookieHeader) => {
          const value = cookieHeader
            ? cookieValue(cookieHeader, ORGANIZATION_SESSION_COOKIE)
            : undefined;
          return value ? encryptSecret(config.keyEncryptionKey, value) : null;
        }
      : async () => null;

  const learningSpace = createLearningSpaceCheck({
    readSettings: () => deps.learningSettingsStore.read(),
    snapshots: deps.snapshots,
    probeTimeoutMs: 3_000,
  });

  // The Learning checks run at once, not one after another: each is bounded by its 3 s probe and cached per container for 60 s.
  const listBots: RecorderExtensionDeps["listBots"] = async (actor) => {
    const profiles = (
      await deps.agentProfileStore.list(await deps.actorFor(actor.id))
    ).filter((bot) => !bot.hidden && bot.deletedAt === null);
    const recordable = await Promise.all(
      profiles.map(async (bot) =>
        (await canRecordForBot(actor.id, bot.id))
          ? {
              id: bot.id,
              name: bot.name,
              learning: await learningSpace(bot.id),
            }
          : null,
      ),
    );
    return recordable.filter((bot) => bot !== null);
  };

  return {
    connections,
    allowedExtensionIds: () => allowedExtensionIds(config),
    listBots,
    user: async (userId) => {
      const row = await userRow(userId);
      return row
        ? { id: row.id, email: row.email, name: row.name?.trim() || row.email }
        : null;
    },
    sealOrganizationSession,
    resolve,
    onRefused: createRecorderRefusalAudit(deps.auditStore),
    canRecordForBot,
    trajectoryCapture: {
      gate: createTrajectoryConnectHook({
        resolveRecorder: resolve,
        canRecordForBot,
        bind: trajectoryBindings.bind,
        audit: createTrajectoryRefusalAudit(deps.auditStore),
      }),
      selectLearningContainers: createTrajectoryLearningSelector({
        botFor: trajectoryBindings.botFor,
        learningSpace,
      }),
    },
  };
}
