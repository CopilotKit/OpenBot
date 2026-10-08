import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { type CredentialStore, encryptSecret } from "../credentials";
import {
  exchangeGithubCode,
  fetchGithubUser,
  githubRedirectUri,
  openGithubState,
} from "./github-oauth";
import { GITHUB_DOTCOM_REALM } from "./providers";
import type { IdentityStore } from "./store";

export type GithubCallbackDeps = {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  appUrl: string | undefined;
  encryptionKey: string;
  personIsActive(userId: string): Promise<boolean>;
  credentials: Pick<
    CredentialStore,
    "create" | "rotate" | "revoke" | "findLiveByKey"
  >;
  identity: Pick<IdentityStore, "linkVerified">;
  auditStore?: AuditStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * Finishes linking a GitHub account when GitHub sends the person back.
 *
 * Every exit is a redirect to the connected-accounts page, `?linked=github` or `?linked=failed`;
 * nothing the vendor or the request carried (code, tokens, secret, state) is logged or returned.
 */
export function githubCallbackRoutes(
  deps: GithubCallbackDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const base = `${(deps.appUrl ?? "").replace(/\/+$/, "")}/settings/connected-accounts?linked=`;
  const now = deps.now ?? (() => new Date());

  routes.get("/", async (context) => {
    const failed = () => context.redirect(`${base}failed`, 302);
    try {
      const code = context.req.query("code");
      if (context.req.query("error") || !code) return failed();

      const state = await openGithubState(
        context.req.query("state"),
        deps.encryptionKey,
        now(),
      );
      if (!state) return failed();

      // The signed-in session must be the person who started the link; otherwise a link started by
      // one person could attach another person's GitHub account to this session (login CSRF).
      const sessionUserId = context.var.actor?.id;
      if (!sessionUserId || sessionUserId !== state.userId) return failed();

      if (!(await deps.personIsActive(state.userId))) return failed();

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
      const user = await fetchGithubUser(tokens.accessToken, deps.fetchImpl);

      const key = {
        kind: "connector" as const,
        provider: "github-user-token",
        keyId: `${state.userId}:${user.id}`,
      };
      const value = {
        ...key,
        metadata: { login: user.login },
        encryptedValue: await encryptSecret(
          deps.encryptionKey,
          JSON.stringify(tokens),
        ),
      };
      const live = await deps.credentials.findLiveByKey(key);
      const stored = live
        ? await deps.credentials.rotate({
            ...value,
            previousCredentialId: live.id,
          })
        : await deps.credentials.create(value);

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
        try {
          await deps.credentials.revoke(stored.id);
        } catch {
          // Already revoked or unreachable: the redirect below is the answer either way.
        }
        throw error;
      }

      if (deps.auditStore) {
        await recordAuditEvent(deps.auditStore, {
          eventType: "identity.linked",
          targetType: "identity_link",
          targetId: link.id,
          actorUserId: state.userId,
          payload: { actor: state.userId, provider: "github" },
        });
      }
      return context.redirect(`${base}github`, 302);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "identity-github-callback-failed",
          reason: error instanceof Error ? error.name : "unknown",
        }),
      );
      return failed();
    }
  });

  return routes;
}
