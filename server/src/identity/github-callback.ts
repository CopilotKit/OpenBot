import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { type CredentialStore, encryptSecret } from "../credentials";
import {
  exchangeGithubCode,
  fetchGithubUser,
  GithubOAuthError,
  githubRedirectUri,
  openGithubState,
} from "./github-oauth";
import { GITHUB_DOTCOM_REALM } from "./providers";
import type { IdentityStore } from "./store";
import { IdentityConflictError } from "./types";

export type GithubCallbackDeps = {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  appUrl: string | undefined;
  encryptionKey: string;
  personIsActive(userId: string): Promise<boolean>;
  credentials: Pick<CredentialStore, "create" | "revoke">;
  identity: Pick<IdentityStore, "linkVerified">;
  auditStore?: AuditStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function logLinkAuditFailure(provider: string, error: unknown): void {
  console.error(
    JSON.stringify({
      type: "identity-link-audit-failed",
      provider,
      error: String(error),
    }),
  );
}

function logRefused(reason: string): void {
  console.warn(
    JSON.stringify({ type: "identity-github-callback-refused", reason }),
  );
}

// Only GithubOAuthError messages are logged: they are fixed sentences. Any other error's message
// could carry vendor or database text, so it contributes its name alone.
function logFailed(stage: string, error: unknown): void {
  console.error(
    JSON.stringify({
      type: "identity-github-callback-failed",
      stage,
      reason: error instanceof Error ? error.name : "unknown",
      ...(error instanceof GithubOAuthError ? { message: error.message } : {}),
    }),
  );
}

/**
 * Finishes linking a GitHub account when GitHub sends the person back.
 *
 * Every exit this router reaches is a redirect to the connected-accounts page, `?linked=github`,
 * `?linked=github-taken` (the account is already linked to another person) or `?linked=failed`. A request with no session never gets here: requireUser answers it with a 401
 * first. Each failed exit logs one line saying which refusal or stage it was; nothing the vendor
 * or the request carried (code, tokens, secret, state, account or session ids) is logged or returned.
 */
export function githubCallbackRoutes(
  deps: GithubCallbackDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const base = `${(deps.appUrl ?? "").replace(/\/+$/, "")}/settings/connected-accounts?linked=`;
  const now = deps.now ?? (() => new Date());

  routes.get("/", async (context) => {
    const failed = () => context.redirect(`${base}failed`, 302);
    let stage = "state";
    try {
      const code = context.req.query("code");
      if (context.req.query("error")) {
        logRefused("declined");
        return failed();
      }
      if (!code) {
        logRefused("no-code");
        return failed();
      }

      const state = await openGithubState(
        context.req.query("state"),
        deps.encryptionKey,
        now(),
      );
      if (!state) {
        logRefused("state-invalid");
        return failed();
      }

      // The signed-in session must be the person who started the link; otherwise a link started by
      // one person could attach another person's GitHub account to this session (login CSRF).
      const sessionUserId = context.var.actor?.id;
      if (!sessionUserId || sessionUserId !== state.userId) {
        logRefused("session-mismatch");
        return failed();
      }

      stage = "person";
      if (!(await deps.personIsActive(state.userId))) {
        logRefused("inactive-person");
        return failed();
      }

      stage = "exchange";
      const tokens = await exchangeGithubCode(
        {
          clientId: deps.clientId,
          clientSecret: deps.clientSecret,
          code,
          redirectUri: githubRedirectUri(deps.publicUrl),
        },
        deps.fetchImpl,
        now(),
      );
      stage = "user";
      const user = await fetchGithubUser(tokens.accessToken, deps.fetchImpl);

      // Every connection stores its token under a key of its own, so it never collides with the
      // token a reconnect replaces (one live credential per key). Nothing reads this token by key:
      // the link names it by id, and linkVerified revokes the token the link named before in the
      // same transaction that repoints it. That keeps one live token per person and account, and
      // a link write that fails leaves the existing link and its token exactly as they were.
      stage = "store";
      const stored = await deps.credentials.create({
        kind: "connector",
        provider: "github-user-token",
        keyId: `${state.userId}:${user.id}:${randomUUID()}`,
        metadata: { login: user.login },
        encryptedValue: await encryptSecret(
          deps.encryptionKey,
          JSON.stringify(tokens),
        ),
      });

      stage = "link";
      let link: Awaited<ReturnType<IdentityStore["linkVerified"]>>;
      try {
        link = await deps.identity.linkVerified(
          {
            provider: "github",
            realm: GITHUB_DOTCOM_REALM,
            subject: String(user.id),
          },
          state.userId,
          { method: "oauth", handle: user.login, credentialId: stored.id },
        );
      } catch (error) {
        // Only the token this attempt stored; the existing link's token was never touched.
        try {
          await deps.credentials.revoke(stored.id);
        } catch (revokeError) {
          // Already revoked or unreachable: the redirect below is the answer either way.
          logFailed("revoke", revokeError);
        }
        // The account belongs to a different person. Say so, without saying whose: retrying can
        // never work, so `?linked=failed` ("try again") would mislead.
        if (error instanceof IdentityConflictError) {
          logFailed("link", error);
          return context.redirect(`${base}github-taken`, 302);
        }
        throw error;
      }

      // The link and its token are live from here on. A failed audit write is logged and does not
      // turn the redirect into `?linked=failed`, whose notice says nothing was saved.
      if (deps.auditStore) {
        await recordAuditEvent(deps.auditStore, {
          eventType: "identity.linked",
          targetType: "identity_link",
          targetId: link.id,
          actorUserId: state.userId,
          payload: { actor: state.userId, provider: "github" },
        }).catch((error) => logLinkAuditFailure("github", error));
      }
      return context.redirect(`${base}github`, 302);
    } catch (error) {
      logFailed(stage, error);
      return failed();
    }
  });

  return routes;
}
