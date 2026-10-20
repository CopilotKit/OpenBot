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
 * The six things a person can be told about one app on one Bot.
 *
 * `ready` — usable now. `not_connected` / `reconnect` — waiting on this person's own account, which
 * they connect or reconnect themselves. `shared_not_connected` — a Shared app whose team account an
 * administrator has not connected. `disabled` — switched off at the deployment. `not_granted` —
 * enabled, and this Bot holds none of it.
 */
export type AppAccessState =
  | "ready"
  | "not_connected"
  | "reconnect"
  | "shared_not_connected"
  | "disabled"
  | "not_granted";

/** What a press of Request access asks an administrator for. */
export type AppAccessRequestKind = "enable" | "grant" | "connect_shared";

export type AppAccess = {
  /** The server id the app has, or the one enabling it would mint. What a request names. */
  key: string;
  /** The app's own name — "Gmail", never a humanised server id. */
  displayName: string;
  logo: string | null;
  provider: "composio" | "catalogue" | "custom";
  /** Whose account calls land in: each person's own, one team account, or nobody's. */
  account: "personal" | "shared" | "deployment";
  /** How the account is connected: this deployment's OAuth flow, a Composio consent, or a key form. */
  connect: "oauth" | "consent" | "key" | null;
  authScheme: string | null;
  accountMode: "personal" | "shared" | null;
  state: AppAccessState;
  /** Whether this Bot holds any of the app's tools. */
  granted: boolean;
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
  mine: () => ["plugins", "app-access", "mine"] as const,
  inbox: (app?: string) =>
    ["plugins", "app-access", "inbox", { app: app ?? null }] as const,
};

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

/** The person's own pending requests. */
export function myAppAccessRequestsQueryOptions() {
  return queryOptions({
    queryKey: appAccessKeys.mine(),
    queryFn: (): Promise<AppAccessRequest[]> =>
      client("/api/plugins/access-requests/mine", "requests", {
        fallback: "Your access requests could not be loaded.",
      }),
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
