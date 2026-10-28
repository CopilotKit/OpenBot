import type {
  CopilotRuntimeHooks,
  GetTrajectoryLearningContainerIds,
} from "@copilotkit/runtime/v2";
import { eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import type { AuthenticatedActor, RoleRepository } from "../auth/guards";
import {
  ORGANIZATION_SESSION_COOKIE,
  ORGANIZATION_SESSION_MAX_AGE_SECONDS,
  organizationCookieExpiresAt,
} from "../auth/organization";
import type { DeploymentConfig } from "../config";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { PersonalLearningSpaces } from "../learning/personal-space";
import type { PeopleStore } from "../people/store";
import {
  createRecorderConnectionStore,
  type RecorderConnectionLifetime,
} from "./connections";
import { allowedExtensionIds } from "./extension-origins";
import {
  createRecorderResolver,
  type RecorderMode,
  type RecorderRefusalSink,
  type RecorderResolver,
} from "./guard";
import { createRecorderRefusalAudit } from "./refusal-audit";
import type { RecorderRouteDeps } from "./routes";
import { createRecorderSignOut, type SignOutRecorders } from "./sign-out";
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
  /** Ends a person's Recorders when their sign-in here ends (recorder/sign-out.ts): what every such path calls. */
  signOut: SignOutRecorders;
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

/** Better Auth's session lifetime, which a deployment that signs people in through it must say: a connection with no
 * lifetime would never end. */
function betterAuthLifetime(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    throw new Error(
      "The Recorder needs Better Auth's session lifetime to bound its connections.",
    );
  }
  return ms;
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
  /**
   * How long a Better Auth session lasts here unused, in milliseconds (auth/index.ts `sessionLifetimeMs`, read from the
   * auth instance): a Recorder connection lasts as long. Required where people sign in through Better Auth; single-user
   * and organization mode take their lifetime from elsewhere.
   */
  sessionLifetimeMs?: number;
  /**
   * Where a connection's own rows go, given the transaction that makes or ends it (connections.ts): index.ts passes
   * `createAuditStore` over it. Absent, `auditStore` as it is: a test's own, which keeps a row whether or not the
   * transaction commits.
   */
  auditFor?: (executor: Database) => AuditStore;
}): RecorderExtensionDeps & {
  /** The capture pass, for `mountCopilotRuntime`: its gate (an onBeforeHandler hook) and its Learning space selector. */
  trajectoryCapture: {
    gate: NonNullable<CopilotRuntimeHooks["onBeforeHandler"]>;
    selectLearningContainers: GetTrajectoryLearningContainerIds;
  };
} {
  const { config, database, organizationAuth } = deps;
  const trajectoryBindings = createTrajectoryBindingStore(database);
  const { personalSpaces } = deps;

  /*
   * A connection is a sign-in of its own, so it lasts as the person's sign-in here does. Better Auth's session ends once
   * it has gone unused for its `expiresIn`; an organization session is a cookie that ends at its own expiry, and the
   * connection carries a sealed copy of it, which must not outlive the cookie. A single-user OpenBot has no sign-in.
   */
  const lifetime: RecorderConnectionLifetime = config.singleUser
    ? null
    : organizationAuth
      ? {
          kind: "organization",
          ms: ORGANIZATION_SESSION_MAX_AGE_SECONDS * 1_000,
        }
      : { kind: "idle", ms: betterAuthLifetime(deps.sessionLifetimeMs) };
  const connections = createRecorderConnectionStore(database, {
    lifetime,
    auditFor: deps.auditFor ?? (() => deps.auditStore),
  });

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
  const resolve = createRecorderResolver({
    connections,
    mode,
    user: userRow,
    endConnection: async (userId, connectionId) => {
      await connections.revoke(
        userId,
        connectionId,
        "signed_out",
        "organization",
      );
    },
  });

  // Sealed with when the cookie itself expires, which the connection made from it keeps and ends at.
  const sealOrganizationSession: RecorderExtensionDeps["sealOrganizationSession"] =
    organizationAuth
      ? async (cookieHeader) => {
          const value = cookieHeader
            ? cookieValue(cookieHeader, ORGANIZATION_SESSION_COOKIE)
            : undefined;
          return value
            ? {
                sealed: await encryptSecret(config.keyEncryptionKey, value),
                expiresAt: organizationCookieExpiresAt(value),
              }
            : null;
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
    signOut: createRecorderSignOut({
      connections,
      auditStore: deps.auditStore,
    }),
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
