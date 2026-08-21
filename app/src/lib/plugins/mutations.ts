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

function invalidatePlugins(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: pluginKeys.all });
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
        await client("/api/plugins/grants", {
          method: "POST",
          body: {
            kind: variables.kind,
            ref: variables.ref,
            agentId: variables.agentId,
          },
          fallback: "That Agent could not be changed.",
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=${variables.kind}&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: "That Agent could not be changed." },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
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
    onSuccess: () => invalidatePlugins(queryClient),
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
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/** Re-read a server's tool list, which is what makes a newly-added tool appear. */
export function refreshPluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(`/api/plugins/servers/${serverId}/refresh`, {
        method: "POST",
        body: {},
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
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
    onSuccess: () => invalidatePlugins(queryClient),
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
    onSuccess: () => invalidatePlugins(queryClient),
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
    onSuccess: () => invalidatePlugins(queryClient),
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
 */
export function connectAccountMutationOptions(
  returnTo: "settings" | "admin" = "settings",
) {
  return mutationOptions({
    mutationFn: (serverId: string): Promise<string> =>
      client<string>(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connect?returnTo=${returnTo}`,
        "authorizationUrl",
        { method: "POST", fallback: "That account could not be connected." },
      ),
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
    onSuccess: () => invalidatePlugins(queryClient),
  });
}
