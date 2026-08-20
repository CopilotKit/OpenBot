import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/** A tool one server offers, as the Plugins page sees it. */
export type PluginTool = {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `<serverId>/<name>`. What a grant names. */
  ref: string;
  /** Whether it changes something. Anything not positively known to be a read is a write. */
  effect: "read" | "write";
  grantedTo: string[];
};

export type PluginServer = {
  id: string;
  title: string;
  vendor: string;
  url: string;
  summary: string;
  docsUrl: string;
  /** `first-party` for a reviewed entry, `custom` for one an administrator added by URL. */
  provenance: string;
  hasCredential: boolean;
  toolsRefreshedAt: string | null;
  lastError: string | null;
  addedBy: string | null;
  tools: PluginTool[];
};

export type PluginSkill = {
  id: string;
  slug: string;
  /** Whose it is. Null means the deployment's: an administrator looks after it. */
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  grantedTo: string[];
};

export type CatalogueItem = {
  key: string;
  title: string;
  vendor: string;
  summary: string;
  docsUrl: string;
  /**
   * Whose credential reaches this server.
   *
   * `deployment-bearer` is a token an administrator holds for everybody, and the only one this page
   * can collect. `user-oauth` is reached as whoever is asking, so each person connects their own
   * account and there is no token to type here.
   */
  auth: "none" | "deployment-bearer" | "user-oauth";
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
  /**
   * The redirect URI to register with a `user-oauth` vendor, exactly as this deployment will send it.
   *
   * From the server rather than assembled here, because it has to match what was registered
   * character for character. Null when the deployment has no public URL and so cannot complete a
   * consent flow at all.
   */
  redirectUri: string | null;
};

/** What one Bot holds, which is all the runtime needs to offer it. */
export type GrantedPlugins = {
  tools: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  skills: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }[];
};

export const pluginKeys = {
  all: ["plugins"] as const,
  page: () => ["plugins", "page"] as const,
  forAgent: (agentId: string) => ["plugins", "for-agent", agentId] as const,
  connections: () => ["plugins", "connections"] as const,
};

/** One account this person has connected, from their own point of view. */
export type PluginConnection = {
  serverId: string;
  /** What the vendor actually granted, which is not always what was asked for. */
  scope: string;
  connectedAt: string;
};

export type PluginConnections = {
  connections: PluginConnection[];
  redirectUri: string | null;
};

/**
 * The signed-in person's own connections.
 *
 * There is no version of this scoped to anybody else: the endpoint answers for whoever is asking,
 * so a page cannot accidentally render somebody else's.
 */
export function connectionsQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.connections(),
    queryFn: async (): Promise<PluginConnections> => {
      const response = await client("/api/plugins/connections", {
        fallback: "Your connected accounts could not be loaded.",
      });
      return response.json();
    },
  });
}

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await client("/api/plugins", {
        fallback: "Plugins could not be loaded.",
      });
      return response.json();
    },
  });
}

/**
 * Polled grant snapshot for what the active Bot should be offered; call-time checks still enforce.
 */
export function agentPluginsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: pluginKeys.forAgent(agentId),
    enabled: agentId.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<GrantedPlugins> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { fallback: "This Bot's plugins could not be read." },
      );
      return response.json();
    },
  });
}

export type PluginCallOutcome =
  | { ok: true; text: string; isError: boolean }
  /** The deployment decided against it. `rule` names the expression, when one decided. */
  | { ok: false; refused: true; reason: string; rule: string | null }
  /** Remote server failure; distinct from a policy refusal. */
  | { ok: false; refused: false; reason: string };

/**
 * Call a tool as a Bot, with server-side grant and policy rechecks for mid-run revocations.
 */
export async function callPluginTool(
  ref: string,
  args: Record<string, unknown>,
  agentId: string,
  signal?: AbortSignal,
): Promise<PluginCallOutcome> {
  /* A refused tool is an outcome this returns, not an error it throws. */
  const response = await tryClient("/api/plugins/call", {
    method: "POST",
    body: { ref, args, agentId },
    signal,
  });

  const body = (await response.json().catch(() => null)) as {
    text?: string;
    isError?: boolean;
    error?: string;
    rule?: string | null;
  } | null;

  if (response.ok) {
    return {
      ok: true,
      text: body?.text ?? "",
      isError: body?.isError === true,
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      refused: true,
      reason: body?.error ?? "That tool is not allowed here.",
      rule: body?.rule ?? null,
    };
  }
  return {
    ok: false,
    refused: false,
    reason: body?.error ?? "The server did not answer.",
  };
}
