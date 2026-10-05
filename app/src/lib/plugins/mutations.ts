import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { pluginKeys } from "./queries";

/**
 * Writes against what a deployment has installed: MCP servers, skills, and which Bots carry them.
 *
 * Servers and skills are two kinds of the same thing here — a plugin the deployment holds and grants
 * — which is why one grant endpoint serves both and takes the kind as an argument rather than having
 * two of everything.
 */

/** A skill as the server accepts it. `global` is an administrator writing for everybody. */
export type SkillInput = {
  slug: string;
  title: string;
  summary?: string;
  instructions: string;
  global?: boolean;
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * Sent on every save, including empty, because the server replaces the set rather than merging
   * into it: omitting the field to mean "leave them alone" and sending `[]` to mean "clear them"
   * would be the same request from a form that just had its last one unticked.
   */
  tools?: string[];
};

/** A curated server from the catalogue, which supplies the URL. */
export type CuratedServerInput = {
  key: string;
  instanceHost?: string;
  credentialId?: string;
};

/**
 * A server somebody typed the URL of, which therefore has to pass the URL checks.
 *
 * `token` is carried through as the previous version did. It is already a credential by the time
 * this is sent — the id beside it is what the record keeps — so the server has no use for it.
 */
export type CustomServerInput = {
  id: string;
  title: string;
  url: string;
  token?: string;
  credentialId?: string;
};

/** Which kinds of plugin a grant can be about. */
export type PluginKind = "mcp" | "skill";

const FALLBACK = "That did not work.";

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
 * THE SHAPE, IN THE SERVER'S OWN WORDS. `POST /servers` inserts the row and then refreshes the
 * server's tools, answering 409 when that refresh faults over a row that is now there.
 * `POST /composio/apps` creates the authorization config at Composio, writes the row, and says so in
 * its own 409. `POST /grants`, `DELETE /grants`, `POST /skills` and `DELETE /skills/:slug` each
 * commit and then file the trail row, and a failing audit insert is a 500 over a change that
 * happened. `DELETE /servers/:id/connection` revokes the account at the vendor before it deletes
 * anything here. And the two brokered writes the screens draw hardest on raise from inside the
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
 */
export function grantPlugin(variables: {
  kind: PluginKind;
  ref: string;
  agentId: string;
}): Promise<unknown> {
  return client("/api/plugins/grants", {
    method: "POST",
    body: {
      kind: variables.kind,
      ref: variables.ref,
      agentId: variables.agentId,
    },
    fallback: "That Agent could not be changed.",
  });
}

/**
 * Whether one Bot carries one plugin.
 *
 * Granting posts to the collection; withholding deletes from it, and the delete identifies the row
 * by query string because a grant has no id of its own — it is the three things it joins.
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
      await client(
        `/api/plugins/grants?kind=${variables.kind}&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: "That Agent could not be changed." },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

export function addCuratedServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CuratedServerInput) => {
      await client("/api/plugins/servers", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

export function addCustomServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CustomServerInput) => {
      await client("/api/plugins/servers/custom", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Add a Composio app to the deployment, named by its slug.
 *
 * Its own endpoint rather than a curated key, because the catalogue is the vendor's rather than
 * ours: the slug is all the server needs to look the app up and record the row.
 */
export function enableComposioAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { slug: string }) => {
      await client("/api/plugins/composio/apps", {
        method: "POST",
        body: input,
        fallback: "That app could not be added.",
      });
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Re-read a server's tool list, which is what makes a newly-added tool appear.
 *
 * The id is encoded, as every id in this file is. It is not this app's text: a custom server's id
 * is whatever an administrator typed when they added it, so a `/` in one adds a path segment the
 * URL parser resolves before any handler sees it, and a `?` truncates the id into a query. This was
 * the one interpolation here that went in raw.
 */
export function refreshPluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/refresh`,
        {
          method: "POST",
          body: {},
          fallback: FALLBACK,
        },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

export function removePluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(`/api/plugins/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Write a skill, or rewrite one.
 *
 * One endpoint for both: the slug is the identity, so posting an existing one replaces it. The
 * fallback names saving rather than creating for that reason.
 */
export function saveSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: SkillInput): Promise<unknown> =>
      client("/api/plugins/skills", {
        method: "POST",
        body: input,
        /*
         * The server refuses for reasons a form cannot check — a slug somebody else already owns is
         * the common one — and paraphrasing that would throw away the only part worth reading.
         */
        fallback: "The skill could not be saved.",
      }),
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/** The deployment's OAuth client for a vendor reached as the person asking. */
export type OAuthClientInput = {
  serverId: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Register the deployment's OAuth client for a `user-oauth` server.
 *
 * Its own write rather than a field on the curated-server input, because it has its own lifetime: a
 * client is rotated without the server being re-added, and re-adding a server should not mean
 * re-typing a client. It is also recorded against the server row, so it can only happen once that
 * row exists — which is why the page chains it rather than sending both at once.
 *
 * Nobody's documents are reachable with what this sends. A client identifies this deployment to the
 * vendor; the grant that reads anything belongs to each person and is made on their own settings page.
 */
export function registerOAuthClientMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: OAuthClientInput) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(input.serverId)}/oauth-client`,
        {
          method: "POST",
          body: { clientId: input.clientId, clientSecret: input.clientSecret },
          fallback: "That OAuth client could not be registered.",
        },
      );
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
 */
export function connectAccountMutationOptions(
  returnTo: "settings" | "admin" = "settings",
) {
  return mutationOptions({
    mutationFn: async (serverId: string): Promise<string | null> => {
      const authorizationUrl = await client<string | undefined>(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connect?returnTo=${returnTo}`,
        "authorizationUrl",
        { method: "POST", fallback: "That account could not be connected." },
      );
      return authorizationUrl ?? null;
    },
  });
}

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
) {
  return mutationOptions({
    mutationFn: async (
      serverId: string,
    ): Promise<BrokeredConnectionConfirmation> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/confirm`,
        { method: "POST", fallback: "That connection could not be confirmed." },
      );
      return response.json();
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * End the signed-in person's brokered connection.
 *
 * Ends the account at Composio rather than only here. Forgetting the row on our side would leave
 * the vendor still holding a live grant on somebody's mailbox, which is not what the person who
 * pressed disconnect was told would happen.
 */
export function disconnectBrokeredMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection`,
        {
          method: "DELETE",
          fallback: "That account could not be disconnected.",
        },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

export function removeSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(`/api/plugins/skills/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSettled: () => invalidatePlugins(queryClient),
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
export function brokeredConnectionFieldsMutationOptions() {
  return mutationOptions({
    mutationFn: async (serverId: string): Promise<BrokerField[] | null> => {
      const fields = await client<BrokerField[] | undefined>(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connect`,
        "fields",
        {
          method: "POST",
          fallback: "That app could not be asked what it needs.",
        },
      );
      return fields ?? null;
    },
  });
}

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
) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      values: Record<string, string>;
    }): Promise<BrokeredKeyConnection> => {
      try {
        const response = await client(
          `/api/plugins/servers/${encodeURIComponent(variables.serverId)}/connect`,
          {
            method: "POST",
            body: { values: variables.values },
            fallback: "That account could not be connected.",
          },
        );
        return response.json();
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
) {
  return mutationOptions({
    mutationFn: async (serverId: string): Promise<BrokeredKeyCheck> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connection/recheck`,
        { method: "POST", fallback: "That connection could not be checked." },
      );
      return response.json();
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}
