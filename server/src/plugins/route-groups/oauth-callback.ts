import { reasonWithoutStatement } from "../../db/query-failure";
import { catalogueEntry } from "../catalogue";
import {
  connectedAccountsUrlFor,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
} from "../oauth";
import type { PluginRouteContext } from "./context";

/** Where a vendor sends a person back after consent. */
export function mountOAuthCallbackRoute({
  routes,
  store,
  connect,
}: PluginRouteContext) {
  /**
   * Where the vendor sends somebody back.
   *
   * Deliberately not behind `requireUser`. The person arrives on a redirect from another company's
   * server, and whose connection this is comes from the sealed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's Google account to another person's row.
   *
   * Having no session is what makes the access check below necessary. Every other route asks the
   * question by being behind a guard; this one has to ask it out loud.
   *
   * Every failure ends the same way: back at Settings with a word about what happened, and nothing
   * written. There is no useful distinction here for the person between a forged state and an expired
   * one, and spelling out which is which tells anybody probing this endpoint how far they got.
   */
  routes.get("/oauth/callback", async (context) => {
    const failed = connectedAccountsUrlFor(connect?.appUrl, {
      failed: true,
    });
    if (!connect?.publicUrl) return context.redirect(failed);

    /*
     * EVERY WAY OUT OF THIS HANDLER IS A REDIRECT, AND THE `try` IS WHAT MAKES THAT TRUE.
     *
     * CRITERION. No request to this endpoint ends without a `Location`.
     *
     * REASON. The header above says every failure ends the same way, and that was true of
     * every failure this handler ASKED for and of none of the failures its questions could
     * raise. `personHasAccess` reaches the people store and `oauthClientFor` reaches the
     * vault, and either of them throwing put somebody who had just consented at another
     * company on a bodyless 500 with no `Location` at all — no page, no notice, nothing to
     * press, and a browser left on this API's origin, which locally serves no pages at all.
     * It is the exact answer this route exists to make impossible: `redeemAuthorizationCode`
     * guards its own `fetch` against it in as many words, and the vault write below was given
     * a `catch` for it — one call at a time, which is the shape that keeps leaving one out.
     *
     * SO IT IS THE WHOLE BODY RATHER THAN EACH CALL. A blanket `catch` is a promise about the
     * route; a per-call one is a promise about the calls somebody remembered. Nothing is
     * written before the vault, so a failure anywhere above it leaves the same nothing behind
     * as an unreadable state does, and the person is told the same sentence either way.
     *
     * THE PERSON LEARNS NOTHING NEW FROM IT, deliberately, for the reason the header gives:
     * there is no useful distinction here between a forged state and a store that would not
     * answer, and spelling out which is which tells anybody probing this endpoint how far they
     * got. The console is where the difference survives, and it carries the error stringified
     * and nothing else — not the state, which names a person, and not the code, which is one
     * redemption away from a refresh token.
     */
    try {
      const code = context.req.query("code");
      const state = await readConnectState(
        context.req.query("state") ?? "",
        connect.encryptionKey,
      );
      if (!code || !state) return context.redirect(failed);

      /*
       * Is the person in the state still somebody here?
       *
       * Asked here, before the code is redeemed and before anything is written, because a state is
       * good for ten minutes and access can end inside them. Removing somebody deny-lists their
       * address, deletes their sessions and retires the credentials they had already granted — and
       * none of that reaches a consent already in flight at the vendor. Without this, that consent
       * comes back and writes a fresh, live refresh token belonging to somebody who no longer has
       * access, which nothing downstream will ever revoke because nothing knows it was created.
       *
       * The same anonymous failure as an unreadable state. Whether an address is deny-listed is not a
       * fact this endpoint owes an unauthenticated caller.
       */
      if (!(await connect.personHasAccess(state.userId))) {
        return context.redirect(failed);
      }

      const entry = catalogueEntry(state.serverId);
      if (entry?.auth.kind !== "user-oauth") return context.redirect(failed);

      const client = await store.oauthClientFor(state.serverId);
      if (!client) return context.redirect(failed);

      const grant = await redeemAuthorizationCode({
        tokenUrl: entry.auth.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: redirectUriFor(connect.publicUrl),
        verifier: state.verifier,
      });
      if (!grant) return context.redirect(failed);

      /*
       * The last thing that can fail, answered the same way as everything before it.
       *
       * A vault that will not take the grant is this deployment's problem, not the person's, and they
       * have already done their part at the vendor. Unhandled, this threw past the handler and gave
       * them the bare 500 that every other failure on this route was written to avoid, on the one
       * path where they had most reason to think it had worked.
       *
       * Told, because unlike the refusals above this one is nobody's fault but ours, and the person's
       * sentence deliberately says nothing about which failure it was. The refresh token is not
       * logged: it is the one thing here worth stealing, and the row it belonged to was never written.
       */
      try {
        await store.recordConnection({
          serverId: state.serverId,
          userId: state.userId,
          refreshToken: grant.refreshToken,
          scope: grant.scope,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "oauth-connection-not-recorded",
            serverId: state.serverId,
            note: "A person consented and the grant could not be stored. They were sent back to Settings with a failure and will have to connect again.",
            /*
             * READ THROUGH {@link reasonWithoutStatement}, BECAUSE THE FAILURE THIS LINE EXISTS FOR
             * IS THE ONE WHOSE MESSAGE CARRIES THE REFRESH TOKEN.
             *
             * `recordConnection` runs `swapUserCredential` → `credentials.create/rotate`, whose
             * bound parameters include `encryptedValue: await encryptSecret(key, refreshToken)`.
             * drizzle wraps a driver failure as a `DrizzleQueryError` whose own message is
             * `Failed query: insert into "credentials" … params: …, <the envelope>, …`, so
             * `String(error)` here put the envelope on this deployment's stdout and into whatever
             * sink collects it — for a person who was correctly told nothing was saved. Two consent
             * callbacks for one `(serverId, userId)` landing together, or a statement timeout on
             * the insert, is all it takes.
             *
             * The helper answers the driver's own complaint instead — `duplicate key value violates
             * unique constraint`, `canceling statement due to statement timeout` — which is the
             * useful half and names nothing anybody sent.
             */
            error: reasonWithoutStatement(error),
          }),
        );
        return context.redirect(failed);
      }

      return context.redirect(
        connectedAccountsUrlFor(
          connect.appUrl,
          { serverId: state.serverId },
          // From the sealed state, so the destination is one this deployment chose, not the browser.
          state.returnTo,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "oauth-callback-failed",
          note: "A person came back from a consent screen and a check on this route raised instead of answering. They were sent back to Settings with a failure, nothing was written, and they will have to connect again.",
          // The outer catch of the branch above, so it stands over the same write and needs the
          // same door. See the note on `oauth-connection-not-recorded`.
          error: reasonWithoutStatement(error),
        }),
      );
      return context.redirect(failed);
    }
  });
}
