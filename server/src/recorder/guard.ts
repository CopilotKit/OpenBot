import { createHash } from "node:crypto";
import {
  RECORDER_AUTHORITY_UNAVAILABLE,
  RECORDER_SIGNED_OUT,
  RECORDER_TOKEN_PREFIX,
  TRAJECTORY_GATE_REFUSALS,
} from "@openbot/shared/recorder-api";
import type { MiddlewareHandler } from "hono";
import { DEV_ACTOR } from "../auth/dev-actor";
import { emailDomainAllowed } from "../auth/email-domain";
import type { AuthenticatedActor, RoleRepository } from "../auth/guards";
import {
  AuthorityUnavailable,
  ORGANIZATION_SESSION_COOKIE,
} from "../auth/organization";
import type { OpenBotRole } from "../auth/roles";
import { reasonWithoutStatement } from "../db/query-failure";
import type { RecorderConnectionStore } from "./connections";
import type { RecorderVariables } from "./variables";

export type RecorderActor = AuthenticatedActor & { connectionId: string };
export type RecorderRefusal =
  | "malformed"
  | "unknown"
  | "removed"
  | "organization"
  | "forbidden";
/** null = no recorder bearer on the request. `unavailable`: the organization's sign-in server could not answer for now
 * (it threw AuthorityUnavailable, or answered something other than a valid actor, a 401 or a 403): never a sign-out, never cached. */
export type RecorderResolution =
  | { actor: RecorderActor }
  | { refused: RecorderRefusal; userId?: string }
  | { unavailable: true }
  | null;
export type RecorderResolver = (
  request: Request,
) => Promise<RecorderResolution>;
export type RecorderMode =
  | { kind: "single-user" }
  | {
      kind: "better-auth";
      roles: RoleRepository;
      isRevoked(email: string): Promise<boolean>;
      allowedEmailDomains: readonly string[];
    }
  | {
      kind: "organization";
      /** The wiring's `organizationAuth.verifySessionQuietly`. */
      session(cookieHeader: string): Promise<AuthenticatedActor | null>;
      unseal(value: string): Promise<string>;
    };
export type RecorderRefusalSink = (refusal: {
  reason: RecorderRefusal;
  path: string;
  tokenDigest: string | null;
  userId?: string;
}) => void;

export const RECORDER_BEARER = /^Bearer (obr_[A-Za-z0-9_-]{43})$/;

/** Anything that starts like a recorder token is taken as one, and only as one; anything else is not this guard's. */
export const RECORDER_BEARER_PREFIX = `Bearer ${RECORDER_TOKEN_PREFIX}`;
/** How long the organization's verdict on one connection is trusted on this replica. */
const ORGANIZATION_VERDICT_TTL_MS = 60_000;

type OrganizationVerdict = { role: OpenBotRole } | { refused: "organization" };
/** The organization's verdicts on this replica, by connection id, oldest first. */
export type OrganizationVerdictCache = Map<
  string,
  { at: number; verdict: OrganizationVerdict }
>;

/** The first 16 hex digits of the offered recorder token's SHA-256, so a refusal can be correlated without keeping the token. */
function digestOf(header: string | undefined): string | null {
  if (!header?.startsWith(RECORDER_BEARER_PREFIX)) return null;
  return createHash("sha256")
    .update(header.slice("Bearer ".length))
    .digest("hex")
    .slice(0, 16);
}

/** Admin beats user, exactly as `createRequireUser` decides. */
function strongestRole(roles: OpenBotRole[]): OpenBotRole | undefined {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("user")) return "user";
  return undefined;
}

export function createRecorderResolver(deps: {
  connections: Pick<RecorderConnectionStore, "resolve">;
  mode: RecorderMode;
  user: (userId: string) => Promise<{
    id: string;
    email: string;
    name: string | null;
    image: string | null;
  } | null>;
  now?: () => number;
  /** Test seam: the cache the organization's verdicts are kept in. */
  verdicts?: OrganizationVerdictCache;
  /**
   * Organization mode: the organization no longer signs in the session this connection holds a copy of, so the
   * connection ends (connections.ts `revoke`, with its sealed copy). Whatever ended that session at the organization (a
   * sign-out there, signing out everywhere, a password reset, an administrator) ends the Recorder with it, the next
   * time it asks.
   */
  endConnection?: (userId: string, connectionId: string) => Promise<void>;
}): RecorderResolver {
  const now = deps.now ?? Date.now;
  const organizationVerdicts: OrganizationVerdictCache =
    deps.verdicts ?? new Map();

  /** Keeps a fresh verdict and drops the expired ones. A key is deleted before it is set again, so insertion order is
   * time order and the expired entries are a prefix. */
  function remember(connectionId: string, verdict: OrganizationVerdict) {
    const at = now();
    for (const [key, entry] of organizationVerdicts) {
      if (at - entry.at < ORGANIZATION_VERDICT_TTL_MS) break;
      organizationVerdicts.delete(key);
    }
    organizationVerdicts.delete(connectionId);
    organizationVerdicts.set(connectionId, { at, verdict });
  }

  /** Asks the organization whether the connection's sealed session is still signed in, and as whom. */
  async function askOrganization(
    mode: Extract<RecorderMode, { kind: "organization" }>,
    connection: { userId: string; organizationSession: string | null },
  ): Promise<OrganizationVerdict> {
    if (!connection.organizationSession) return { refused: "organization" };
    const value = await mode.unseal(connection.organizationSession);
    const session = await mode.session(
      `${ORGANIZATION_SESSION_COOKIE}=${value}`,
    );
    // A session the authority now answers for somebody else is not this connection's person signing in.
    if (!session || session.id !== connection.userId) {
      return { refused: "organization" };
    }
    return { role: session.role };
  }

  return async (request) => {
    const header = request.headers.get("authorization");
    if (!header?.startsWith(RECORDER_BEARER_PREFIX)) return null;
    const token = RECORDER_BEARER.exec(header)?.[1];
    if (!token) return { refused: "malformed" };
    const connection = await deps.connections.resolve(token);
    if (!connection) return { refused: "unknown" };
    const { connectionId, userId } = connection;
    const user = await deps.user(userId);
    if (!user) return { refused: "unknown", userId };
    // The runtime refuses a blank name, so the email stands in for a missing one.
    const person = {
      id: userId,
      email: user.email,
      name: user.name?.trim() || user.email,
      image: user.image,
    };

    const { mode } = deps;
    if (mode.kind === "single-user") {
      if (userId !== DEV_ACTOR.id) return { refused: "unknown", userId };
      return {
        actor: { ...DEV_ACTOR, name: DEV_ACTOR.email, connectionId },
      };
    }

    if (mode.kind === "better-auth") {
      if (
        (await mode.isRevoked(user.email)) ||
        !emailDomainAllowed(user.email, mode.allowedEmailDomains)
      ) {
        return { refused: "removed", userId };
      }
      const role = strongestRole(await mode.roles.rolesForUser(userId));
      if (!role) return { refused: "forbidden", userId };
      return { actor: { ...person, role, connectionId } };
    }

    let verdict: OrganizationVerdict;
    const cached = organizationVerdicts.get(connectionId);
    if (cached && now() - cached.at < ORGANIZATION_VERDICT_TTL_MS) {
      verdict = cached.verdict;
    } else {
      try {
        verdict = await askOrganization(mode, connection);
      } catch (error) {
        // Not a sign-out, and not cached: the next request asks again.
        if (error instanceof AuthorityUnavailable) return { unavailable: true };
        throw error;
      }
      remember(connectionId, verdict);
      if ("refused" in verdict && deps.endConnection) {
        // The refusal stands either way: the organization refuses this session on every ask.
        await deps.endConnection(userId, connectionId).catch((error: unknown) =>
          console.error(
            JSON.stringify({
              type: "recorder-organization-end-failed",
              error: reasonWithoutStatement(error),
            }),
          ),
        );
      }
    }
    if ("refused" in verdict) return { refused: "organization", userId };
    return { actor: { ...person, role: verdict.role, connectionId } };
  };
}

export function createRequireRecorder(
  resolve: RecorderResolver,
  onRefused: RecorderRefusalSink,
): MiddlewareHandler<{ Variables: RecorderVariables }> {
  return async (context, next) => {
    const resolution = await resolve(context.req.raw);
    if (resolution && "actor" in resolution) {
      const { connectionId, ...person } = resolution.actor;
      context.set("actor", person);
      context.set("recorderConnectionId", connectionId);
      return next();
    }
    if (resolution && "unavailable" in resolution) {
      // The organization's sign-in server could not answer: transient, not a sign-out.
      return context.json(
        {
          error: TRAJECTORY_GATE_REFUSALS.authorityUnavailable.message,
          code: RECORDER_AUTHORITY_UNAVAILABLE,
        },
        503,
      );
    }
    // No bearer at all on a recorder-only route is an unknown token.
    const reason = resolution?.refused ?? "unknown";
    onRefused({
      reason,
      path: context.req.path,
      tokenDigest: digestOf(context.req.header("authorization")),
      ...(resolution?.userId ? { userId: resolution.userId } : {}),
    });
    if (reason === "forbidden") {
      return context.json({ error: "Authorization required." }, 403);
    }
    return context.json(
      {
        error:
          reason === "organization"
            ? "Your organization sign-in ended. Connect this browser to OpenBot again."
            : "This browser is no longer connected to OpenBot. Connect it again.",
        code: RECORDER_SIGNED_OUT,
        reason:
          reason === "removed"
            ? "removed"
            : reason === "organization"
              ? "organization"
              : "revoked",
      },
      401,
    );
  };
}
