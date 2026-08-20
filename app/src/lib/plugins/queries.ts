import { queryOptions } from "@tanstack/react-query";
import { closeQuestion, openQuestion, waitForApproval } from "@/lib/approvals";

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
  needsCredential: boolean;
  /** True for a vendor that gives every customer their own hostname. */
  perInstance: boolean;
};

export type PluginsPage = {
  catalogue: CatalogueItem[];
  servers: PluginServer[];
  skills: PluginSkill[];
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
};

export function pluginsPageQueryOptions() {
  return queryOptions({
    queryKey: pluginKeys.page(),
    queryFn: async (): Promise<PluginsPage> => {
      const response = await fetch("/api/plugins", { credentials: "include" });
      if (!response.ok) throw new Error("Plugins could not be loaded.");
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
      const response = await fetch(
        `/api/plugins/for/${encodeURIComponent(agentId)}`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error("This Bot's plugins could not be read.");
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
 *
 * A call the boundary wants a person's answer to comes back here as a pause rather than a failure,
 * and this holds it open, puts the question on the tool call's own line, and sends the identical
 * call again with the answer attached. A tool call that reported "not allowed" to the model instead
 * would throw away the turn on work the deployment was willing to permit, which is the whole
 * difference between an ask rule and a deny rule.
 */
export async function callPluginTool(
  ref: string,
  args: Record<string, unknown>,
  agentId: string,
  signal?: AbortSignal,
  toolCallId?: string,
): Promise<PluginCallOutcome> {
  const outcome = await sendCall(ref, args, agentId, signal);
  if (!("awaitingApproval" in outcome)) return outcome;

  openQuestion(toolCallId ?? "", {
    approvalId: outcome.approvalId,
    botId: agentId,
    question: outcome.question,
    rule: outcome.rule,
  });
  try {
    const answer = await waitForApproval(agentId, outcome.approvalId, signal);
    if (answer === "granted") {
      // Sent once, not through this function again. A second ask on the retry would mean the answer
      // did not fit the call, and looping on that would hold the turn open until the deadline
      // instead of telling the model something it can act on, so a question raised on the retry is
      // reported rather than waited on.
      const retried = await sendCall(
        ref,
        args,
        agentId,
        signal,
        outcome.approvalId,
      );
      return "awaitingApproval" in retried
        ? {
            ok: false,
            refused: false,
            reason:
              "That was allowed, but the answer did not fit the call being made, so it did not happen.",
          }
        : retried;
    }
    return answer === "declined"
      ? {
          ok: false,
          refused: true,
          reason: "A person declined that.",
          rule: outcome.rule,
        }
      : {
          ok: false,
          refused: false,
          reason:
            answer === "cancelled"
              ? "Stopped."
              : "Nobody answered the request to allow that, so it did not happen. Say what you " +
                "were waiting for rather than trying another way round it.",
        };
  } finally {
    closeQuestion(toolCallId ?? "");
  }
}

/** A question the server raised about this call, as the reply that paused it carried it. */
type AwaitingApproval = {
  awaitingApproval: true;
  approvalId: string;
  question: string;
  rule: string | null;
};

async function sendCall(
  ref: string,
  args: Record<string, unknown>,
  agentId: string,
  signal?: AbortSignal,
  approvalId?: string,
): Promise<PluginCallOutcome | AwaitingApproval> {
  const response = await fetch("/api/plugins/call", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ref,
      args,
      agentId,
      // Sent identically to the call that was asked about, because the server binds an answer to a
      // fingerprint of the call, arguments included: anything else comes back as a different action.
      ...(approvalId ? { approvalId } : {}),
    }),
    ...(signal ? { signal } : {}),
  });

  const body = (await response.json().catch(() => null)) as {
    text?: string;
    isError?: boolean;
    error?: string;
    rule?: string | null;
    awaitingApproval?: boolean;
    approvalId?: string;
    question?: string;
  } | null;

  if (response.ok) {
    return {
      ok: true,
      text: body?.text ?? "",
      isError: body?.isError === true,
    };
  }
  // Read before anything else a 409 can mean, and never shown to the model: the caller above is
  // going to wait and then send the very same call again.
  if (response.status === 409 && body?.awaitingApproval === true) {
    return {
      awaitingApproval: true,
      approvalId: body.approvalId ?? "",
      question: body.question ?? body.error ?? "",
      rule: body.rule ?? null,
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
