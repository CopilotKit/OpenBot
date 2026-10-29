import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * What each work app is for the person looking, on one Bot, and the requests they file when only an
 * administrator can change it.
 *
 * THE STATE IS THE SERVER'S. The browser draws `state` and `requestKind` as they arrive and never
 * derives either from the other fields: whether an app is switched off, held by the Bot, connected
 * by this person or waiting on a team account is read on the server from the same tables every
 * call gate reads.
 */

/**
 * The eight things a person can be told about one app on one Bot.
 *
 * `ready` — usable now. `not_connected` / `reconnect` — waiting on an account: this person's own,
 * which they connect or reconnect themselves, or on somebody else's Team Bot the owner's, which only
 * the owner can (see `accountHolder`). `shared_not_connected` — a Shared app whose team account an
 * administrator has not connected. `shared_not_approved` — a Shared app whose team account IS
 * connected, but an administrator has not approved this Bot's audience for it, so every call is
 * refused; the refused call files the administrator's request itself, so there is none to press.
 * `disabled` — switched off at the deployment, for the reason `unavailable` gives. `not_granted` —
 * enabled, and this Bot holds none of it; only an admin can give it. `owner_grantable` — the same,
 * except the person looking owns the Bot and the app is open to owners, so they can give it
 * themselves (see `needsConnect`).
 */
export type AppAccessState =
  | "ready"
  | "not_connected"
  | "reconnect"
  | "shared_not_connected"
  | "shared_not_approved"
  | "disabled"
  | "not_granted"
  | "owner_grantable";

/**
 * Why an app is switched off. `absent` — nobody switched it on here. `composio_unconfigured` — a
 * brokered app (Composio or Arcade) on a deployment with no key for its broker. The other three — a scheme the server cannot
 * read, an OAuth client nobody registered, a token nobody pasted — are a set-up left unfinished.
 */
export type AppUnavailable =
  | "absent"
  | "composio_unconfigured"
  | "scheme_unreadable"
  | "oauth_client_missing"
  | "token_missing";

/** What a press of Request access asks an administrator for. */
export type AppAccessRequestKind = "enable" | "grant" | "connect_shared";

export type AppAccess = {
  /** The server id the app has, or the one enabling it would mint. What a request names. */
  key: string;
  /** The app's own name — "Gmail", never a humanised server id. */
  displayName: string;
  logo: string | null;
  /** A brokered app names its broker; a catalogue or custom app is reached directly. */
  provider: "composio" | "arcade" | "catalogue" | "custom";
  /** Whose account calls land in: each person's own, one team account, or nobody's. */
  account: "personal" | "shared" | "deployment";
  /** How the account is connected: this deployment's OAuth flow, a broker's consent, or a key form. */
  connect: "oauth" | "consent" | "key" | null;
  authScheme: string | null;
  accountMode: "personal" | "shared" | null;
  state: AppAccessState;
  /** Why the app is switched off, when state is "disabled"; null otherwise. */
  unavailable: AppUnavailable | null;
  /**
   * Whose account a personal-account app's calls use for this person on this Bot: "you", or "owner"
   * when this is somebody else's published Team Bot and its owner has connected the app (calls then
   * run on the owner's account). null when the app is not a personal-account app.
   */
  accountHolder: "you" | "owner" | null;
  /**
   * True when calls will use this person's OWN account on somebody else's Team Bot and they have not
   * given standing consent: the first use raises an "Allow once / Always allow" card. State is "ready".
   */
  asksFirst: boolean;
  /** Whether this Bot holds any of the app's tools. */
  granted: boolean;
  /** Who may give the app to a Bot: any Bot's owner, or only an admin. */
  ownerGrants: "any" | "admin";
  /** Whether everything this Bot holds of the app was given by its owner, who may take it back. */
  givenByOwner: boolean;
  /**
   * In `owner_grantable`, whether giving it has to start with connecting the person's own account.
   * False in every other state.
   */
  needsConnect: boolean;
  /**
   * When the account this app runs in for this person was connected, or null. Read by the chat card
   * to tell an account lost at the vendor from one connected again since. See `AppAccessCard`.
   */
  connectedAt: string | null;
  /** The request Request access files for this state; null where the next step is the person's. */
  requestKind: AppAccessRequestKind | null;
  /** This person's pending request of exactly that kind — drawn as "Requested". */
  request: { id: string; kind: AppAccessRequestKind; createdAt: string } | null;
};

/** A request as the person who filed it and the administrator answering it both read it. */
export type AppAccessRequest = {
  id: string;
  appKey: string;
  appTitle: string;
  kind: AppAccessRequestKind;
  status: "pending" | "approved" | "dismissed" | "cancelled";
  agentId: string | null;
  botName: string | null;
  requestedBy: string;
  requesterEmail: string | null;
  requesterName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

/** The administrator's inbox: the requests asked for, and a count per app for the Plugins list. */
export type AppAccessInbox = {
  requests: AppAccessRequest[];
  counts: { total: number; byApp: Record<string, number> };
};

/*
 * UNDER `["plugins"]`, so every plugin write that already refreshes the plugin screens — connecting
 * an account, enabling an app, granting a tool — refreshes what these say too, without each of
 * those writes having to know this view exists.
 */
export const appAccessKeys = {
  all: ["plugins", "app-access"] as const,
  bot: (agentId: string) => ["plugins", "app-access", "bot", agentId] as const,
  app: (agentId: string, app: string) =>
    ["plugins", "app-access", "bot", agentId, "app", app] as const,
  inbox: (app?: string) =>
    ["plugins", "app-access", "inbox", { app: app ?? null }] as const,
  giveable: ["plugins", "app-access", "giveable"] as const,
};

/** An app this person could give their own Bots. */
export type GiveableApp = Pick<
  AppAccess,
  "key" | "displayName" | "logo" | "account"
>;

/**
 * The apps this person could give their own Bots: switched on and open to owners, and connected
 * where the app runs on their own account. What the New Bot sheet offers ticked, and the switches
 * on a Bot's page. Empty where an admin turned the feature off for them.
 */
export function giveableAppsQueryOptions() {
  return queryOptions({
    queryKey: appAccessKeys.giveable,
    queryFn: (): Promise<GiveableApp[]> =>
      client("/api/plugins/giveable", "apps", {
        fallback: "Couldn't load your apps.",
      }),
  });
}

/** Every work app this Bot holds, with what each is for the person asking. */
export function botAppsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: appAccessKeys.bot(agentId),
    queryFn: (): Promise<AppAccess[]> =>
      client(`/api/plugins/for/${encodeURIComponent(agentId)}/apps`, "apps", {
        fallback: "This Bot's apps could not be loaded.",
      }),
  });
}

/**
 * One app, by key or by name, whether or not this Bot holds it — what a card in a conversation
 * asks, so it never draws a stale state.
 */
export function botAppQueryOptions(agentId: string, app: string) {
  return queryOptions({
    queryKey: appAccessKeys.app(agentId, app),
    queryFn: (): Promise<AppAccess> =>
      client(
        `/api/plugins/for/${encodeURIComponent(agentId)}/apps/${encodeURIComponent(app)}`,
        "app",
        { fallback: `What ${app} is for this Bot could not be loaded.` },
      ),
  });
}

/**
 * The pending requests an administrator answers: one app's, or all of them. The counts are always
 * the whole deployment's. `enabled` is false for anybody who is not an administrator, who would be
 * answered 403.
 */
export function appAccessInboxQueryOptions(enabled: boolean, app?: string) {
  return queryOptions({
    queryKey: appAccessKeys.inbox(app),
    queryFn: async (): Promise<AppAccessInbox> => {
      const query = app ? `?app=${encodeURIComponent(app)}` : "";
      const response = await client(`/api/plugins/access-requests${query}`, {
        fallback: "Access requests could not be loaded.",
      });
      return response.json();
    },
    enabled,
  });
}
