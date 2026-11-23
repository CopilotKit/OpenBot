import {
  type MutationFunctionContext,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteBotGrant,
  replaceBotGrant,
} from "@/lib/api/generated/bot-grants/bot-grants";
import {
  confirmConnection,
  confirmSharedConnection,
  connectApp,
  connectSharedApp,
  disconnectApp,
  disconnectConnectedAccount,
  disconnectSharedApp,
  makeConnectedAccountDefault,
  recheckConnection,
  recheckSharedConnection,
} from "@/lib/api/generated/connections/connections";
import type {
  ConnectionStart as ApiConnectionStart,
  ConnectAppRequest,
} from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { desktopShell } from "@/lib/desktop/shell";
import { confirmOnReturn } from "./confirm-on-return";
import { pluginKeys } from "./queries";
import type { SharedUseApproval } from "./shared-use";

/**
 * Writes against what a deployment has installed: MCP servers, skills, and which Bots carry them.
 *
 * Servers and skills are two kinds of the same thing here — a plugin the deployment holds and grants
 * — which is why one grant endpoint serves both and takes the kind as an argument rather than having
 * two of everything.
 */

/** Which kinds of plugin a grant can be about. */
export type PluginKind = "mcp" | "skill";

/**
 * Refetch everything the plugin screens read.
 *
 * Exported because a bulk grant has to say when: N of these in a row, each awaiting its own
 * refetch, is a dialog that spends most of a batch re-reading a list nobody has looked at yet.
 *
 * ON `onSettled` AND NEVER ON `onSuccess`, ON EVERY WRITE BELOW, AND IT IS ONE FACT ABOUT THE SERVER
 * RATHER THAN A PREFERENCE. NOT ONE OF THESE ENDPOINTS IS ATOMIC. Every one of them writes something
 * durable and then does something else that can fail, so a refusal is not evidence that nothing
 * changed — it is very often the opposite, and the write it leaves behind is exactly the one the
 * screen is drawing.
 *
 * THE SHAPE, IN THE SERVER'S OWN WORDS. Adding an app (createApp) writes the app and then asks it
 * what it offers, answering 409 when that faults over an app that is now there, and adding one from
 * the directory creates its authorization config at the directory's service first.
 * `POST /grants`, `DELETE /grants`, `POST /skills` and `DELETE /skills/:slug` each commit and then
 * file the trail row, and a failing audit insert is a 500 over a change that happened.
 * disconnectApp revokes the account at the vendor before it deletes anything here. And the two
 * brokered writes the screens draw hardest on raise from inside the
 * store AFTER recording what they found: `recheckBrokeredConnection` writes the verdict and the
 * action it spent and then raises with Composio's refusal, and `connectBrokeredWithFields` records
 * the account it could not withdraw and then raises with a sentence telling the person to disconnect
 * it — on a page that, refetching only on success, went on offering them Connect.
 *
 * WHAT `onSuccess` COST, PRECISELY. It made the browser's copy of the deployment diverge on exactly
 * the presses where a person is reading hardest: a banner carrying the server's refusal, over a row
 * still drawn from the state before the request. Two readings of one screen in one paint, and the
 * stale one is always the reassuring one. `onSettled` runs on both outcomes, so the screen is drawn
 * from what the deployment holds NOW rather than from what the press was hoping for — which costs a
 * refused write one refetch and is the only rule under which the row and the banner can agree.
 *
 * THE ONE WRITE-SHAPED PRESS THIS DOES NOT APPLY TO is {@link brokeredConnectionFieldsMutationOptions},
 * which asks what an app wants typed in. That is a question about the app rather than about
 * anybody's account, it writes nothing on either outcome, and it takes no `QueryClient` at all — so
 * the exemption is structural rather than a decision this comment has to be trusted about.
 */
export function invalidatePlugins(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: pluginKeys.all });
}

/**
 * Grant one plugin to one Bot, and refetch nothing.
 *
 * The write on its own, for the caller granting a batch of them: the server still records a row per
 * grant, so the audit trail is unchanged, but the reader is refreshed once at the end rather than
 * between every pair. Anything granting a single one should use the mutation below instead, which
 * carries the refetch with it.
 *
 * `approval` IS HOW A GRANT ON A SHARED APP NARROWS ITS OWN AUDIENCE. Granting a Bot a shared app it
 * is not yet covered for is what provokes the audience refusal in the first place, so the one screen
 * that offers the grant is also where an administrator can pre-empt it by shipping the approval the
 * grant would otherwise go ask for. Sent only when present, for the reason every optional body field
 * in this file is: a grant that carries no opinion about audience must not read as one that narrowed
 * it to nothing.
 */
export function grantPlugin(variables: {
  kind: PluginKind | "bot";
  ref: string;
  agentId: string;
  approval?: SharedUseApproval;
}): Promise<unknown> {
  return replaceBotGrant(
    organizationId(),
    variables.agentId,
    grantIdOf(variables.kind, variables.ref),
    { "Idempotency-Key": idempotencyKey() },
    variables.approval ? { approval: variables.approval } : {},
    { fallback: "Couldn't change that Bot." },
  );
}

/**
 * Take one thing from a Bot. A Bot that doesn't have it is already without it, so that answer is the
 * write done, as it always was here.
 */
export async function revokePlugin(variables: {
  kind: PluginKind | "bot";
  ref: string;
  agentId: string;
}): Promise<void> {
  try {
    await deleteBotGrant(
      organizationId(),
      variables.agentId,
      grantIdOf(variables.kind, variables.ref),
      { "Idempotency-Key": idempotencyKey() },
      { fallback: "Couldn't change that Bot." },
    );
  } catch (error) {
    if (error instanceof ClientError && error.code === "BOT_GRANT_NOT_FOUND")
      return;
    throw error;
  }
}

/**
 * A grant's address in the API: `action:<app id>:<action name>` for an app's action (its ref is
 * `<app id>/<action name>`), `skill:<slug>`, or `bot:<Bot id>`.
 */
export function grantIdOf(kind: PluginKind | "bot", ref: string): string {
  if (kind === "skill") return `skill:${ref}`;
  if (kind === "bot") return `bot:${ref}`;
  const slash = ref.indexOf("/");
  return slash < 0
    ? `action:${ref}:`
    : `action:${ref.slice(0, slash)}:${ref.slice(slash + 1)}`;
}

/**
 * Whether one Bot carries one plugin.
 *
 * Granting puts the grant at its address under the Bot (replaceBotGrant); withholding deletes it
 * there (deleteBotGrant). The address is the kind and what it names (see {@link grantIdOf}).
 */
export function setPluginGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      kind: PluginKind;
      ref: string;
      agentId: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await grantPlugin(variables);
        return;
      }
      await revokePlugin(variables);
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Begin connecting the signed-in person's own account.
 *
 * Answers with the vendor's consent URL rather than navigating, so the caller decides when to leave
 * the page. There is deliberately nothing here that could complete the consent on somebody's behalf.
 */
/**
 * Start a consent flow, and say which screen it started from.
 *
 * `returnTo` decides where the vendor's callback puts somebody down, because two screens offer this:
 * a person's own connected-accounts page, and the connector's admin page where an administrator
 * verifies the setup they have just finished. Sending an administrator to their personal settings
 * afterwards is the round trip the inline row exists to remove.
 *
 * A name rather than a URL. The server narrows it to a known set before signing it into the state,
 * so this parameter cannot become an open redirect however it is called.
 *
 * NO URL IS A REAL ANSWER AND THE CALLER HAS TO BRANCH ON IT. One route serves both kinds of
 * brokered app: it answers `{ authorizationUrl }` to a press on an app somebody consents to, and
 * `{ fields }` to a press on one whose key somebody types. This unwraps the first key, so a press
 * that landed on the second kind unwraps nothing — and while this was declared `Promise<string>`
 * the one caller assigned that nothing to `window.location.href`, which the browser resolves
 * against the current document and follows: a person pressing Connect was taken to a page called
 * `undefined` on this deployment's own origin, having been told nothing.
 *
 * AND IT IS NOT A HYPOTHETICAL, because the two processes decide it from two copies of one list.
 * The screen's `FIELD_SCHEMES` says which schemes are typed and the server's `isFieldScheme` says
 * the same thing again; Composio's catalogue is the vendor's and may name a new typed scheme
 * tomorrow, which the screen would read as consent — deliberately, because an unknown scheme is
 * better sent to a consent screen than to an empty form — and the route would answer a form to.
 * That is the state this type now describes rather than hides.
 *
 * `null` RATHER THAN `undefined`, AND THE DIFFERENCE IS THE WHOLE OF WHY THIS WENT UNNOTICED.
 * `mutationFn` is an OPTIONAL property, so `useMutation` infers its data type out of
 * `MutationFunction<T, …> | undefined` — and matching that against the source strips the
 * `undefined` from both sides, `T`'s own included. A `Promise<string | undefined>` here therefore
 * reaches every caller as a bare `string`: `onSuccess` binds its parameter to `string`, the
 * assignment to `window.location.href` typechecks, and the compiler has been told the same lie in
 * a second place. `null` is the one absent-value this inference cannot quietly discard, which is
 * what makes the branch below it obligatory rather than advisory.
 *
 * AND A THIRD ANSWER, WHICH IS NOT A URL AND NOT A FORM: `{ connected: true }`. A brokered app
 * whose account the vendor already holds, with no row for it here, is recorded by the route on
 * the spot, so the press ends connected with no page to visit. Unwrapping only the url read that
 * answer as `null`, and every caller drew `null` as "this app takes a key" or as a failure, over an
 * account that had just been recorded as connected. It is its own member of {@link ConnectStart}
 * so a caller has to say what it draws for it.
 */
export function connectAccountMutationOptions(
  returnTo: "settings" | "admin" = "settings",
  shared = false,
) {
  return mutationOptions({
    mutationFn: async (
      serverId: string,
      context: MutationFunctionContext,
    ): Promise<ConnectStart> =>
      confirmedOnReturn(
        context.client,
        serverId,
        shared,
        startOf(
          await startConnect(serverId, {
            returnTo,
            shared,
            fallback: "Couldn't connect that account.",
          }),
        ),
      ),
  });
}

/**
 * Connect one more account at an app the person already has an account at: a second mailbox, a
 * work calendar beside a personal one. The same press as Connect, asking for another account
 * rather than for more permissions on the one that stands.
 */
export function connectAnotherAccountMutationOptions(
  returnTo: "settings" | "admin" = "settings",
) {
  return mutationOptions({
    mutationFn: async (
      serverId: string,
      context: MutationFunctionContext,
    ): Promise<ConnectStart> =>
      confirmedOnReturn(
        context.client,
        serverId,
        false,
        startOf(
          await startConnect(serverId, {
            returnTo,
            another: true,
            fallback: "Couldn't connect that account.",
          }),
        ),
      ),
  });
}

/**
 * Every consent a connect press starts, in one place: in OpenBot Desktop's window the account is
 * confirmed when the window is back in front, whatever screen it is on ({@link confirmOnReturn}).
 * A person's own connection is confirmed as the return page did before, falling back to the app's
 * shared account where the app has one.
 */
function confirmedOnReturn(
  queryClient: QueryClient,
  serverId: string,
  shared: boolean,
  start: ConnectStart,
): ConnectStart {
  if (start !== null && "authorizationUrl" in start)
    confirmOnReturn(queryClient, serverId, () =>
      confirmBrokeredConnection(serverId, shared || undefined),
    );
  return start;
}

/**
 * One press of Connect, at the person's own connection or, for a Shared app, the app's shared one.
 * Where the person comes back to is one of OpenBot's own pages: the app's page for admins, the
 * person's connection page, or OpenBot Desktop when the press came from its window.
 */
function startConnect(
  serverId: string,
  press: {
    returnTo: "settings" | "admin";
    fallback: string;
    shared?: boolean;
    another?: boolean;
    values?: Record<string, string>;
  },
): Promise<ApiConnectionStart> {
  const headers = { "Idempotency-Key": idempotencyKey() };
  const options = { fallback: press.fallback };
  if (press.shared)
    return connectSharedApp(
      organizationId(),
      serverId,
      {
        returnTo: desktopShell() ? "desktop" : "apps",
        ...(press.values ? { values: press.values } : {}),
      },
      headers,
      options,
    );
  const body: ConnectAppRequest = {
    returnTo: desktopShell()
      ? "desktop"
      : press.returnTo === "admin"
        ? "apps"
        : "connections",
    ...(press.another ? { anotherAccount: true } : {}),
    ...(press.values ? { values: press.values } : {}),
  };
  return connectApp(organizationId(), "me", serverId, body, headers, options);
}

/** A sign-in page to visit, an account already connected, or `null` for a key form. */
function startOf(start: ApiConnectionStart): ConnectStart {
  if (start.next === "connected") return { connected: true };
  if (start.next === "consent")
    return { authorizationUrl: start.authorizationUrl };
  return null;
}

/**
 * What one press of Connect started: a consent page to visit, an account that is already
 * connected, or `null` for neither (an app whose key somebody types). See
 * {@link connectAccountMutationOptions}.
 */
export type ConnectStart =
  | { authorizationUrl: string }
  | { connected: true }
  | null;

/**
 * What asking the vendor about an account comes back with.
 *
 * NAMED RATHER THAN WRITTEN INTO THE SIGNATURE AND AGAIN INTO A CAST. Every one of these three
 * answer shapes was stated twice — once as the declared return type and once as an `as` on the
 * parsed body — and the second copy is worse than redundant: a declared type corrected in one place
 * goes on being asserted in the other, which is how a shape nothing produces survives being fixed.
 * The sibling reads in `./queries.ts` have never done it, and these now read the same way: one name,
 * declared once, and `response.json()` under it.
 */
export type BrokeredConnectionConfirmation = { connected: boolean };

/**
 * Ask the vendor whether a brokered connection actually completed.
 *
 * Exists because the return trip from consent proves nothing. The callback is an ordinary redirect
 * with nothing signed in it, so somebody arriving back on the page is not evidence that they
 * finished the flow — or that the account they finished it with is the one the row claims. So the
 * vendor is asked, and its answer is what the connected state is written from.
 *
 * Answers with the body rather than a bare success, because "asked, and told not connected" is a
 * different thing for a screen to say than "could not ask".
 *
 * There is no start half here: beginning a brokered connect is the same write as any other consent
 * flow, so callers use `connectAccountMutationOptions` above, which already reads the vendor's
 * `authorizationUrl` off the connect route.
 */
export function confirmBrokeredConnectionMutationOptions(
  queryClient: QueryClient,
  shared?: boolean,
) {
  return mutationOptions({
    mutationFn: (serverId: string) =>
      confirmBrokeredConnection(serverId, shared),
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/** The confirm itself, for {@link confirmBrokeredConnectionMutationOptions} and the window's return. */
async function confirmBrokeredConnection(
  serverId: string,
  shared?: boolean,
): Promise<BrokeredConnectionConfirmation> {
  const options = { fallback: "Couldn't confirm that connection." };
  const confirmShared = () =>
    confirmSharedConnection(
      organizationId(),
      serverId,
      { "Idempotency-Key": idempotencyKey() },
      options,
    );
  if (shared) return confirmShared();
  try {
    return await confirmConnection(
      organizationId(),
      "me",
      serverId,
      { "Idempotency-Key": idempotencyKey() },
      options,
    );
  } catch (error) {
    /*
     * A caller may know the app and not whose account it was: a person's own connection refuses
     * an app with one shared account as a conflict,
     * and that account is then the one to confirm. A caller that knows says so.
     */
    if (
      shared === undefined &&
      error instanceof ClientError &&
      error.status === 409 &&
      error.code === "CONFLICT"
    )
      return confirmShared();
    throw error;
  }
}

/** Every disconnect of a person's own connection, so the app's page can stop reading it. */
export const disconnectBrokeredMutationKey = [
  ...pluginKeys.all,
  "disconnect",
] as const;

/** Every disconnect of one account, which ends the connection when it was the last. */
export const disconnectBrokeredAccountMutationKey = [
  ...pluginKeys.all,
  "disconnect-account",
] as const;

/**
 * A connection the person just ended: its own reads (the connection and its accounts, and what a
 * disconnect would also end) are dropped rather than read again, since a read would ask for a
 * connection that is gone and answer 404. A read already on its way is dropped too, not left to land
 * in the cache. Every other plugin read is refreshed, the person's connections among them, which is
 * how the page learns the app is not connected.
 */
async function forgetEndedConnection(
  queryClient: QueryClient,
  serverId: string,
) {
  const own = [pluginKeys.accounts(serverId), pluginKeys.siblings(serverId)];
  for (const queryKey of own) {
    await queryClient.cancelQueries({ queryKey });
    queryClient.removeQueries({ queryKey });
  }
  return queryClient.invalidateQueries({
    queryKey: pluginKeys.all,
    predicate: (query) =>
      !own.some(
        (key) =>
          JSON.stringify(query.queryKey.slice(0, key.length)) ===
          JSON.stringify(key),
      ),
  });
}

/**
 * End the signed-in person's brokered connection.
 *
 * Ends the account at Composio rather than only here. Forgetting the row on our side would leave
 * the vendor still holding a live grant on somebody's mailbox, which is not what the person who
 * pressed disconnect was told would happen.
 */
export function disconnectBrokeredMutationOptions(
  queryClient: QueryClient,
  shared = false,
) {
  return mutationOptions({
    mutationKey: disconnectBrokeredMutationKey,
    mutationFn: async (serverId: string) => {
      const headers = { "Idempotency-Key": idempotencyKey() };
      const options = { fallback: "Couldn't disconnect that account." };
      await (shared
        ? disconnectSharedApp(organizationId(), serverId, headers, options)
        : disconnectApp(organizationId(), "me", serverId, headers, options));
    },
    /*
     * In `onSettled`, which a screen's own `onSuccess` and `onError` cannot shadow. A person's own
     * connection that is gone has its reads dropped rather than read again; the app's one shared
     * account is still there to read, not connected, so it is refreshed like the rest, as is
     * everything after a disconnect that failed.
     */
    onSettled: (_result, error, serverId) =>
      error || shared
        ? invalidatePlugins(queryClient)
        : forgetEndedConnection(queryClient, serverId),
  });
}

const ACCOUNT_FALLBACK = "Couldn't change that account.";

/** Make one of the person's accounts at an app the one their Bots use when they name none. */
export function setDefaultBrokeredAccountMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: { serverId: string; accountId: string }) => {
      await makeConnectedAccountDefault(
        organizationId(),
        "me",
        variables.serverId,
        variables.accountId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: ACCOUNT_FALLBACK },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Disconnect one of the person's accounts at an app and keep the rest. The last one ends the
 * connection, as Disconnect always has.
 */
export function disconnectBrokeredAccountMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: disconnectBrokeredAccountMutationKey,
    mutationFn: (variables: { serverId: string; accountId: string }) =>
      disconnectConnectedAccount(
        organizationId(),
        "me",
        variables.serverId,
        variables.accountId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't disconnect that account." },
      ),
    // The last account ends the connection, and the server says so. `onSettled`, as above.
    onSettled: (result, error, variables) =>
      !error && result?.connectionEnded
        ? forgetEndedConnection(queryClient, variables.serverId)
        : invalidatePlugins(queryClient),
  });
}

/**
 * One value Composio wants from the person connecting, as Composio itself describes it.
 *
 * Declared here rather than guessed at a form: the vendor publishes the list per app, `secret` says
 * which one to mask, and `help` is written for the person filling it in. `name` goes back on the
 * wire verbatim and is never shown.
 */
export type BrokerField = {
  name: string;
  label: string;
  help: string;
  required: boolean;
  secret: boolean;
  default?: string;
};

/**
 * Ask what an app wants typed in, for the apps nobody consents to.
 *
 * Most Composio apps are not connected through a consent screen — the person holds an API key and
 * types it in — so the same connect route answers a field list on the first press and takes the
 * values on the second. Nothing is written by this half: it is a question about the app, not about
 * anybody's account, which is why it refetches nothing.
 *
 * NO FIELDS IS A REAL ANSWER HERE TOO, and it is the same defect as
 * {@link connectAccountMutationOptions} seen from the other side: that route answers a URL to a
 * press on an app somebody consents to, so this unwraps nothing whenever the screen asked for a
 * form and the server decided the app takes none. The two mis-read each other in exactly the
 * states the other does, for the one reason — two copies of the list of typed schemes — so neither
 * of these two types may claim a value the route only sometimes sends.
 *
 * `null` for the reason spelled out over {@link connectAccountMutationOptions}: an `undefined` in
 * this position is inferred away by `useMutation` and reaches the caller as a plain `BrokerField[]`.
 */
export function brokeredConnectionFieldsMutationOptions(
  returnTo: "settings" | "admin" = "settings",
  shared = false,
) {
  return mutationOptions({
    mutationFn: async (serverId: string): Promise<KeyForm | null> => {
      const start = await startConnect(serverId, {
        returnTo,
        shared,
        fallback: "Couldn't find out what this app needs.",
      });
      if (start.next !== "form") return null;
      return {
        // The form a person fills in: no default reads as no key at all, as it always has.
        fields: start.fields.map(({ default: seeded, ...field }) =>
          seeded === null ? field : { ...field, default: seeded },
        ),
        guide: start.guide,
      };
    },
  });
}

/**
 * Where a person gets the key an app asks for: what to do there, and the provider's own page for
 * it. `url` is null where nobody has a page to point at; the steps are always there.
 */
export type KeyGuide = { steps: string; url: string | null };

/** What the first press on a key app answers: the boxes to fill in, and where the key comes from. */
export type KeyForm = { fields: BrokerField[]; guide: KeyGuide | null };

/**
 * What handing a key over comes back with. Declared once, for the reason
 * {@link BrokeredConnectionConfirmation} gives.
 */
export type BrokeredKeyConnection = {
  connected: boolean;
  verified: boolean;
  probe: string | null;
};

/**
 * Finish that connection with what the person typed.
 *
 * The values reach no query cache, no router state and no local storage. They are somebody's own
 * key: the request body is the whole of their life in this app, and putting them anywhere a later
 * render could read them back would be keeping a credential we were only ever asked to forward.
 *
 * WHICH IS WHY THIS ERASES ITS OWN INPUT. Handing values to a mutation is not the same as sending
 * them: a mutation keeps the variables it was called with in its state for as long as its observer
 * lives, so the key stayed legible to anything reading mutation state — devtools included — long
 * after the one request it was typed for had finished, and longest of all on the refusal, where the
 * form stays open for as long as somebody spends correcting a key. The `finally` below is what makes
 * "the request body is the whole of their life" true rather than nearly true.
 *
 * IN THE MUTATION FUNCTION RATHER THAN IN A CALLBACK, because callers spread these options and
 * declare their own `onSuccess` and `onError` over them — the refetch below is called by hand for
 * exactly that reason. A callback can be shadowed by the next caller who needs one; this cannot.
 * It replaces the field on the variables object, which is made fresh for each press, so the copy
 * the form itself is holding is untouched and a refused key is still there to be corrected.
 *
 * Answers with the body rather than a bare success, because Composio does not check a submitted key.
 * `connected` is only that the vendor accepted the row; `verified` is whether a real call was made
 * with it, and a screen says different things about the two.
 *
 * AND `probe` IS WHAT SEPARATES THE TWO THINGS `verified: false` MEANS. A null probe is an app that
 * publishes nothing safe to spend a key on, so nothing was tried and "accepted without being
 * checked" is the truth. A NAMED probe beside that same false is the other state entirely: the
 * action ran in this person's account, the vendor rejected the key, and the account could not be
 * withdrawn — so the row exists and the key is bad. A screen reading the boolean alone cannot tell
 * those apart, and would tell the second person that nothing had ever been checked.
 */
export function connectBrokeredWithFieldsMutationOptions(
  queryClient: QueryClient,
  returnTo: "settings" | "admin" = "settings",
  shared = false,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      values: Record<string, string>;
    }): Promise<BrokeredKeyConnection> => {
      try {
        const start = await startConnect(variables.serverId, {
          returnTo,
          shared,
          values: variables.values,
          fallback: "Couldn't connect that account.",
        });
        return start.next === "connected"
          ? {
              connected: true,
              verified: start.verified === true,
              probe: start.checkedAction,
            }
          : { connected: false, verified: false, probe: null };
      } finally {
        // Taken or refused, the request is over and this copy has nothing left to do.
        variables.values = {};
      }
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * What spending a call on a key comes back with. Declared once, for the reason
 * {@link BrokeredConnectionConfirmation} gives.
 *
 * No `connected` here, and the absence is the point: this route is only ever aimed at an account
 * that already exists, so it answers what the check found and never re-asserts that the row is
 * there.
 */
export type BrokeredKeyCheck = {
  verified: boolean;
  verifiedAt: string | null;
  probe: string | null;
};

/**
 * Spend one read-only call at the vendor to find out whether a key still works.
 *
 * A button rather than something a page does on its own. Verifying on every render would spend the
 * person's own rate limit at the vendor to redraw a word, so the check happens when somebody asks
 * for it and the answer is recorded with the time it was taken.
 *
 * `probe` TRAVELS WITH THE VERDICT, for the reason spelled out over
 * {@link connectBrokeredWithFieldsMutationOptions}: the flag alone means three different things and
 * a reader cannot tell them apart. On this route it also decides whether there is anything left to
 * press — a null probe is an app publishing nothing safe to spend a key on, so the check that just
 * ran is the last one there is to run, where a named probe is a check that can be made again as
 * soon as somebody has corrected their key at the vendor.
 *
 * A CHECK THE VENDOR REFUSED DOES NOT ARRIVE HERE AT ALL. That path raises with Composio's own
 * sentence in it, which the banner and the dialog draw; the only `verified: false` this answers with
 * is the one carrying a null probe.
 */
export function recheckBrokeredConnectionMutationOptions(
  queryClient: QueryClient,
  shared = false,
) {
  return mutationOptions({
    mutationFn: async (serverId: string): Promise<BrokeredKeyCheck> => {
      const headers = { "Idempotency-Key": idempotencyKey() };
      const options = { fallback: "Couldn't check that connection." };
      const check = shared
        ? await recheckSharedConnection(
            organizationId(),
            serverId,
            headers,
            options,
          )
        : await recheckConnection(
            organizationId(),
            "me",
            serverId,
            headers,
            options,
          );
      return {
        verified: check.verified,
        verifiedAt: check.verifiedAt,
        probe: check.checkedAction,
      };
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}
