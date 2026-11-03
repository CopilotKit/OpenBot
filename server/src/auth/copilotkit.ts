/**
 * Sign-in through a CopilotKit organization, for an OpenBot hosted for one.
 *
 * This OpenBot serves exactly one CopilotKit organization (a Clerk organization), named by
 * COPILOTKIT_ORGANIZATION_ID. Signing in is the handoff managed Intelligence already uses for its own
 * web app:
 *
 *   1. `GET /api/auth/copilotkit/start` remembers a random `state` in a signed cookie and sends the
 *      browser to the CopilotKit dashboard's handoff route with this OpenBot's callback as the target.
 *   2. The dashboard signs the person in with Clerk, re-checks their membership of their active
 *      organization, and sends them back to the callback with a one-time code (60 seconds, one use).
 *   3. `GET /api/auth/copilotkit/callback` checks the `state` against the cookie, so a code somebody
 *      else obtained cannot be planted in this browser, and redeems the code with CopilotKit server to
 *      server using OpenBot's own credential. CopilotKit answers with the person, their organization,
 *      and their organization role, read from Clerk at that moment.
 *   4. Only a member of COPILOTKIT_ORGANIZATION_ID gets in. They become a local person through Better
 *      Auth's own account machinery, the same path a Google or Okta sign-in takes, so the deny list,
 *      the sign-in stamp and the audit trail apply unchanged. `org:admin` is an admin here and every
 *      other member is a user, written again at every sign-in.
 *
 * A Better Auth plugin, so the session it starts is an ordinary Better Auth session: the request
 * guard, sign-out, the People screen's removal and the Recorder all treat it like any other.
 */
import { randomBytes } from "node:crypto";
import {
  COPILOTKIT_SIGN_IN_START_PATH,
  type CopilotKitSignInError,
} from "@openbot/shared/copilotkit-sign-in";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AuditEventInput } from "../audit";
import type { CopilotKitSignInConfig } from "../config";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";
import { type OpenBotRole, setRole } from "./roles";

/** The account provider id a CopilotKit sign-in is filed under, beside `google` and `okta`. */
export const COPILOTKIT_PROVIDER_ID = "copilotkit";

/** What a person removed by an admin here is told, wherever they try to sign in again. */
export const ACCESS_REMOVED_MESSAGE =
  "Your access to OpenBot has been removed.";

const STATE_COOKIE = "copilotkit_state";
/** Long enough to sign in to CopilotKit, including a forgotten password; the code itself lasts 60 seconds. */
const STATE_MAX_AGE_SECONDS = 10 * 60;
const CALLBACK_PATH = "/copilotkit/callback";

/** The OpenBot role an organization role grants: admins are admins, every other member is a user. */
export function roleFromOrganizationRole(
  organizationRole: string,
): OpenBotRole {
  return organizationRole === "org:admin" ? "admin" : "user";
}

/**
 * What CopilotKit answers when a code is redeemed. Only the fields read here are checked; Ops may
 * add others.
 */
const exchangeSchema = z.object({
  subjectId: z.string().min(1),
  clerkOrganizationId: z.string().min(1),
  actor: z.object({
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  destinationApp: z.literal("openbot"),
  targetUrl: z.string(),
  organizationRole: z.string().min(1),
});

export type CopilotKitExchange = z.infer<typeof exchangeSchema>;

export type RedeemOutcome =
  | { ok: true; exchange: CopilotKitExchange }
  | { ok: false; error: CopilotKitSignInError };

/** The callback CopilotKit sends the browser back to, carrying this sign-in's `state`. */
export function copilotKitCallbackUrl(authBaseUrl: string, state: string) {
  const callback = new URL(`${authBaseUrl}${CALLBACK_PATH}`);
  callback.searchParams.set("state", state);
  // Written exactly as CopilotKit's dashboard normalises it, since the code is bound to this string.
  return callback.toString();
}

/** Where the browser goes to sign in to CopilotKit and come back with a code. */
export function copilotKitSignInUrl(dashboardUrl: string, callbackUrl: string) {
  const url = new URL("/intelligence/handoff", dashboardUrl);
  url.searchParams.set("destinationApp", "openbot");
  url.searchParams.set("targetUrl", callbackUrl);
  return url.toString();
}

/** Ops error codes that mean the code itself is no good: used, expired, or not this callback's. */
const SPENT_CODE_ERRORS = new Set([
  "HANDOFF_INVALID",
  "HANDOFF_EXPIRED",
  "HANDOFF_REPLAYED",
  "HANDOFF_TARGET_NOT_ALLOWED",
]);

/**
 * Redeem a one-time code with CopilotKit, server to server.
 *
 * Never throws for an answer CopilotKit gave: each one becomes the reason the sign-in screen shows.
 * A refusal of OpenBot's own credential is logged for the operator, since nobody signing in can
 * fix it.
 */
export async function redeemCopilotKitCode(
  config: CopilotKitSignInConfig,
  code: string,
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RedeemOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${config.opsApiUrl}/internal/openbot/handoffs/exchange`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-ops-internal-token": config.opsApiToken,
        },
        body: JSON.stringify({ code, targetUrl }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "copilotkit-sign-in-unreachable",
        error: String(error),
      }),
    );
    return { ok: false, error: "copilotkit_unavailable" };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorCode =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string"
        ? body.error.code
        : undefined;
    if (errorCode && SPENT_CODE_ERRORS.has(errorCode))
      return { ok: false, error: "copilotkit_expired" };
    if (errorCode === "HANDOFF_MEMBERSHIP_REVOKED")
      return { ok: false, error: "copilotkit_not_member" };
    console.error(
      JSON.stringify({
        type: "copilotkit-sign-in-refused",
        status: response.status,
        code: errorCode ?? null,
        note:
          errorCode === "INTERNAL_AUTH_REQUIRED" ||
          errorCode === "INTERNAL_AUTH_NOT_CONFIGURED"
            ? "CopilotKit refused COPILOTKIT_OPS_API_TOKEN. It must equal OPS_OPENBOT_INTERNAL_API_TOKEN on the Ops API."
            : undefined,
      }),
    );
    return {
      ok: false,
      error:
        response.status >= 500 ? "copilotkit_unavailable" : "copilotkit_failed",
    };
  }

  const parsed = exchangeSchema.safeParse(body);
  if (!parsed.success || parsed.data.targetUrl !== targetUrl) {
    console.error(
      JSON.stringify({
        type: "copilotkit-sign-in-unreadable",
        issues: parsed.success
          ? ["targetUrl does not match"]
          : parsed.error.issues.map((issue) => issue.path.join(".")),
      }),
    );
    return { ok: false, error: "copilotkit_unavailable" };
  }
  return { ok: true, exchange: parsed.data };
}

/** The one role a person holds here, or undefined for somebody with none yet. */
async function currentRole(
  database: Database,
  userId: string,
): Promise<OpenBotRole | undefined> {
  const rows = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  const roles = rows.map((row) => row.role);
  return roles.includes("admin")
    ? "admin"
    : roles.includes("user")
      ? "user"
      : undefined;
}

/** Whether a Better Auth refusal is the deny list's, by the message the hooks in auth/index.ts throw. */
function isAccessRemoved(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  const body = error.body as { message?: unknown } | undefined;
  return (
    error.message === ACCESS_REMOVED_MESSAGE ||
    body?.message === ACCESS_REMOVED_MESSAGE
  );
}

export function copilotKitSignIn(options: {
  config: CopilotKitSignInConfig;
  database: Database;
  /** Where the browser app is served, for the redirect after sign-in and back to the sign-in screen. */
  appUrl: string;
  /** Writes a row to the audit trail and never throws (see `record` in auth/index.ts). */
  audit: (event: AuditEventInput) => Promise<void>;
  fetch?: typeof fetch;
}) {
  const { config, database, audit } = options;
  const appUrl = options.appUrl.replace(/\/+$/, "");

  return {
    id: "copilotkit-sign-in",
    endpoints: {
      copilotKitSignInStart: createAuthEndpoint(
        COPILOTKIT_SIGN_IN_START_PATH.replace(/^\/api\/auth/, ""),
        { method: "GET" },
        async (ctx) => {
          const state = randomBytes(24).toString("base64url");
          const cookie = ctx.context.createAuthCookie(STATE_COOKIE, {
            maxAge: STATE_MAX_AGE_SECONDS,
          });
          await ctx.setSignedCookie(
            cookie.name,
            state,
            ctx.context.secret,
            cookie.attributes,
          );
          throw ctx.redirect(
            copilotKitSignInUrl(
              config.dashboardUrl,
              copilotKitCallbackUrl(ctx.context.baseURL, state),
            ),
          );
        },
      ),
      copilotKitSignInCallback: createAuthEndpoint(
        CALLBACK_PATH,
        {
          method: "GET",
          query: z.object({
            state: z.string().optional(),
            handoffCode: z.string().optional(),
          }),
        },
        async (ctx) => {
          const backToSignIn = (error: CopilotKitSignInError) =>
            ctx.redirect(`${appUrl}/sign?error=${error}`);

          const cookie = ctx.context.createAuthCookie(STATE_COOKIE);
          const expected = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          expireCookie(ctx, cookie);
          const { state, handoffCode } = ctx.query;
          if (!expected || !state || state !== expected || !handoffCode) {
            throw backToSignIn("copilotkit_expired");
          }

          const outcome = await redeemCopilotKitCode(
            config,
            handoffCode,
            copilotKitCallbackUrl(ctx.context.baseURL, state),
            options.fetch,
          );
          if (!outcome.ok) {
            if (outcome.error === "copilotkit_not_member") {
              await audit({
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  reason:
                    "no longer a member of this OpenBot's CopilotKit organization",
                },
              });
            }
            throw backToSignIn(outcome.error);
          }

          const { exchange } = outcome;
          const email = exchange.actor.email?.trim().toLowerCase();
          if (exchange.clerkOrganizationId !== config.organizationId) {
            await audit({
              eventType: "session.refused",
              targetType: "person",
              payload: {
                email,
                organization: exchange.clerkOrganizationId,
                reason:
                  "not a member of this OpenBot's CopilotKit organization",
              },
            });
            throw backToSignIn("copilotkit_other_organization");
          }
          if (!email) {
            console.error(
              JSON.stringify({
                type: "copilotkit-sign-in-no-email",
                subject: exchange.subjectId,
              }),
            );
            throw backToSignIn("copilotkit_failed");
          }

          let signedIn: Awaited<ReturnType<typeof handleOAuthUserInfo>>;
          try {
            signedIn = await handleOAuthUserInfo(ctx, {
              userInfo: {
                id: exchange.subjectId,
                email,
                // Clerk verified it: the address is the primary email on the person's Clerk account.
                emailVerified: true,
                name: exchange.actor.displayName ?? email,
                image: exchange.actor.avatarUrl ?? undefined,
              },
              account: {
                providerId: COPILOTKIT_PROVIDER_ID,
                issuer: config.opsApiUrl,
                accountId: exchange.subjectId,
              },
              // The organization is the only way into this OpenBot, so its answer about the address
              // is the one that counts, and a name or picture changed there is changed here too.
              isTrustedProvider: true,
              overrideUserInfo: true,
              source: {
                method: "oauth",
                oauth: { providerId: COPILOTKIT_PROVIDER_ID },
              },
            });
          } catch (error) {
            if (isAccessRemoved(error))
              throw backToSignIn("copilotkit_removed");
            console.error(
              JSON.stringify({
                type: "copilotkit-sign-in-failed",
                error: String(error),
              }),
            );
            throw backToSignIn("copilotkit_failed");
          }
          if (signedIn.error !== null || !signedIn.data) {
            console.error(
              JSON.stringify({
                type: "copilotkit-sign-in-failed",
                error: signedIn.error,
              }),
            );
            throw backToSignIn("copilotkit_failed");
          }

          /*
           * The role, from the organization, at every sign-in. Written before the browser has the
           * session, so no request is ever served with the role the person had last time.
           */
          const { user } = signedIn.data;
          const role = roleFromOrganizationRole(exchange.organizationRole);
          const previous = await currentRole(database, user.id);
          await setRole(database, user.id, role);
          if (previous && previous !== role) {
            await audit({
              eventType: "person.role_changed",
              targetType: "person",
              targetId: user.id,
              actorUserId: user.id,
              payload: {
                email,
                from: previous,
                to: role,
                by: "their CopilotKit organization role",
              },
            });
          }

          await setSessionCookie(ctx, signedIn.data);
          throw ctx.redirect(`${appUrl}/`);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
