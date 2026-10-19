import type {
  CopilotRuntimeHooks,
  GetTrajectoryLearningContainerIds,
} from "@copilotkit/runtime/v2";
import { eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import type { AuthenticatedActor, RoleRepository } from "../auth/guards";
import { ORGANIZATION_SESSION_COOKIE } from "../auth/organization";
import type { DeploymentConfig } from "../config";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { PersonalLearningSpaces } from "../learning/personal-space";
import type { PeopleStore } from "../people/store";
import { createRecorderConnectionStore } from "./connections";
import { allowedExtensionIds } from "./extension-origins";
import {
  createRecorderResolver,
  type RecorderMode,
  type RecorderRefusalSink,
  type RecorderResolver,
} from "./guard";
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

/** How long the Recorder's popup waits for the person's Learning space: the capture pass's own budget. */
const LEARNING_SPACE_WAIT_MS = 4_000;

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
  /** Each person's own Learning space, which every recording they make joins. */
  personalSpaces: PersonalLearningSpaces;
  auditStore: AuditStore;
}): RecorderExtensionDeps & {
  /** The capture pass, for `mountCopilotRuntime`: its gate (an onBeforeHandler hook) and its Learning space selector. */
  trajectoryCapture: {
    gate: NonNullable<CopilotRuntimeHooks["onBeforeHandler"]>;
    selectLearningContainers: GetTrajectoryLearningContainerIds;
  };
} {
  const { config, database, organizationAuth } = deps;
  const connections = createRecorderConnectionStore(database);
  const trajectoryBindings = createTrajectoryBindingStore(database);
  const { personalSpaces } = deps;

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

  return {
    connections,
    allowedExtensionIds: () => allowedExtensionIds(config),
    // Bounded like a capture pass, so the popup is not held by a slow Intelligence; a creation it started goes on.
    learningSpace: (actor) =>
      personalSpaces.state(
        actor.id,
        AbortSignal.timeout(LEARNING_SPACE_WAIT_MS),
      ),
    // Made when the browser connects, so a space only a slow credential can make is there before the first recording.
    onConnected: (userId) => personalSpaces.kick(userId),
    user: async (userId) => {
      const row = await userRow(userId);
      return row
        ? { id: row.id, email: row.email, name: row.name?.trim() || row.email }
        : null;
    },
    sealOrganizationSession,
    resolve,
    onRefused: createRecorderRefusalAudit(deps.auditStore),
    trajectoryCapture: {
      gate: createTrajectoryConnectHook({
        resolveRecorder: resolve,
        bind: trajectoryBindings.bind,
        audit: createTrajectoryRefusalAudit(deps.auditStore),
      }),
      selectLearningContainers: createTrajectoryLearningSelector({
        isBoundTo: trajectoryBindings.isBoundTo,
        personalSpace: personalSpaces,
      }),
    },
  };
}
