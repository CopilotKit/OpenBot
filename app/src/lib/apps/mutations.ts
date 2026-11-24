import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createApp,
  deleteApp,
  refreshApp,
  setAppAccountMode,
  setAppOAuthClient,
  updateApp,
} from "@/lib/api/generated/apps/apps";
import type { AddAppFromDirectory, App } from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import type { SharedUseApproval } from "@/lib/plugins/shared-use";

/**
 * Writes to the apps this OpenBot has added, through the API's generated client: adding one (from
 * the catalogue, from the wider directory, or by a server's address), removing it, asking it what it
 * offers, choosing whose account it acts in and who may give it to a Bot, and its OAuth client.
 *
 * Every one refetches everything the plugin screens read when it settles, refused or not
 * (`invalidatePlugins`): a refused add can still have written the app before its actions were read.
 */

const FALLBACK = "That didn't work. Try again.";

/** A catalogue entry to add, by its key; the catalogue supplies the address. */
export type CuratedServerInput = {
  key: string;
  /** The organization's own host, for a vendor that gives every customer one. */
  instanceHost?: string;
  /** The vault credential it is reached with, for an entry reached with a key. */
  credentialId?: string;
};

/** Add an entry of OpenBot's own catalogue (createApp, from a directory entry). An admin's. */
export function addCuratedServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CuratedServerInput): Promise<App> =>
      createApp(
        organizationId(),
        {
          from: "directory",
          directoryEntryId: `catalogue:${input.key}`,
          ...(input.instanceHost ? { instanceHost: input.instanceHost } : {}),
          ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/** What a person types to add an MCP server from Connections. */
export type AddServerByUrlInput = {
  title: string;
  url: string;
  /** A key the server gave them, for a server that needs one. Only an admin may send it. */
  token?: string;
};

/**
 * What adding a server by its address came to. A refusal is an answer here, not a failure: the
 * server needed a key, the admin's MCP allowlist doesn't include it, or it is already added. The
 * screen draws each of them, so they come back as values rather than as a thrown error.
 */
export type AddServerByUrlOutcome =
  | { added: true; server: App; signIn: boolean }
  | {
      added: false;
      error: string;
      /** `needs-key` or `not-approved`, when the refusal is one the screen can offer a step for. */
      code?: "needs-key" | "not-approved";
      /** The app already added at this address, when that is why. */
      serverId?: string;
    };

/**
 * Add an MCP server by its address, from Connections (createApp, by address). The server is asked
 * how it is reached and the answer comes back on `signIn`: true means each person signs in to it
 * next.
 */
export function addServerByUrlMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      input: AddServerByUrlInput,
    ): Promise<AddServerByUrlOutcome> => {
      try {
        const server = await createApp(
          organizationId(),
          {
            from: "address",
            title: input.title,
            url: input.url,
            ...(input.token ? { token: input.token } : {}),
          },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: "Couldn't add that server. Try again." },
        );
        return { added: true, server, signIn: server.signIn };
      } catch (thrown) {
        if (!(thrown instanceof ClientError)) throw thrown;
        return {
          added: false,
          error: thrown.message,
          ...(thrown.code === "APP_NEEDS_KEY"
            ? { code: "needs-key" as const }
            : thrown.code === "APP_NOT_APPROVED"
              ? { code: "not-approved" as const }
              : {}),
          ...(typeof thrown.body?.appId === "string"
            ? { serverId: thrown.body.appId }
            : {}),
        };
      }
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/** A directory entry to add, and, for an entry listed as a sign-in in place of its key, `key`. */
export type DirectoryAppInput = {
  directoryEntryId: string;
  /** Add it with its key instead, as its own app (the entry's `keyVersion`). */
  connectsWith?: AddAppFromDirectory["connectsWith"];
};

/**
 * Add an app of the wider directory (createApp, from a directory entry), named by its entry's id.
 * An admin's. Answers the new app's id, which is what a sign-in started on the same press is asked
 * against, or the key form opened for the key version.
 */
export function addDirectoryAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: DirectoryAppInput): Promise<string> => {
      const app = await createApp(
        organizationId(),
        {
          from: "directory",
          directoryEntryId: input.directoryEntryId,
          ...(input.connectsWith ? { connectsWith: input.connectsWith } : {}),
        },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "That app could not be added." },
      );
      return app.id;
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Ask an app what it offers now (refreshApp), which is what makes a newly-added action appear. The
 * generated client encodes the id, which matters here: a server's id is whatever an admin chose.
 */
export function refreshPluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await refreshApp(
        organizationId(),
        serverId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/** Remove an app for everybody (deleteApp). Safe to press again if it stopped partway. */
export function removePluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await deleteApp(
        organizationId(),
        serverId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
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
 * Set this OpenBot's OAuth client for a catalogue app reached as the person asking
 * (setAppOAuthClient).
 *
 * Its own write rather than a field on adding the app, because it has its own lifetime: a client is
 * rotated without the app being added again. It is recorded against the app, so it can only happen
 * once the app exists, which is why the page chains it rather than sending both at once.
 */
export function registerOAuthClientMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: OAuthClientInput) => {
      await setAppOAuthClient(
        organizationId(),
        input.serverId,
        { clientId: input.clientId, clientSecret: input.clientSecret },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "That OAuth client could not be registered." },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * Who may give an app to a Bot (updateApp): any Bot's owner, for their own Bot, or only an admin.
 */
export function setOwnerGrantsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      ownerGrants: "any" | "admin";
    }) => {
      await updateApp(
        organizationId(),
        variables.serverId,
        { ownerGrants: variables.ownerGrants },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't change who can give this app." },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}

/**
 * What switching an app's account mode would do, asked before it is done.
 *
 * `wouldRevoke` is who loses their account: a person's own connection when the switch is into
 * Shared, or the deployment's shared one when it is switched back out of it. `bots` is every Bot
 * that uses the app when switching to Shared (empty when switching to Personal), each with the
 * approval the switch would give it.
 */
export type AccountModePreview = {
  mode: "personal" | "shared";
  wouldRevoke: { holder: "person" | "deployment"; count: number };
  bots: { botId: string; exposure: SharedUseApproval }[];
};

/**
 * Ask what switching an app to this mode would change, without changing anything: the same
 * operation (setAppAccountMode) with `validateOnly`, so a preview is the real switch asked not to
 * commit rather than a second endpoint to keep in step with it.
 */
export async function accountModePreview(
  serverId: string,
  mode: "personal" | "shared",
): Promise<AccountModePreview> {
  const change = await setAppAccountMode(
    organizationId(),
    serverId,
    { mode, validateOnly: true },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "What the switch would change could not be read." },
  );
  return {
    mode: change.mode,
    wouldRevoke: change.accountsEnded,
    bots: change.bots.map((bot) => ({
      botId: bot.botId,
      exposure: bot.approval,
    })),
  };
}

/**
 * Switch an app's account mode for real. `approvals` carries the admin's narrowed approvals, keyed by
 * Bot id, for Bots the preview listed; a Bot not named gets the approval the preview listed.
 */
export function setAccountModeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      mode: "personal" | "shared";
      approvals?: Record<string, SharedUseApproval>;
    }) => {
      await setAppAccountMode(
        organizationId(),
        variables.serverId,
        {
          mode: variables.mode,
          ...(variables.approvals ? { approvals: variables.approvals } : {}),
        },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "The switch did not finish, and nothing was changed." },
      );
    },
    onSettled: () => invalidatePlugins(queryClient),
  });
}
