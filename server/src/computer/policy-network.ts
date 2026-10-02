/**
 * Which network policy a Bot's computer runs under, and getting it there.
 *
 * The rules and their matcher are `agent-computer/src/egress.ts`, imported rather than copied so the
 * API server refusing a navigation and the computer refusing a connection are the same code.
 *
 * WHO A COMPUTER BELONGS TO is the Bot's owner (`agent_profiles.owner_user_id`). Their directory
 * groups pick the policy: a group with a policy of its own replaces the organization's, unless the
 * organization policy is locked (Grok Bot: "groups can override team policy with their own, with
 * optional locks enforcing team-level restrictions"). When the owner's "Cloud network access"
 * capability is off, the computer gets `deny_all` whatever the policy says.
 *
 * APPLIED LIVE by pushing to every running computer: on the enterprise LISTEN/NOTIFY announcement
 * (see `admin/controls.ts`) and on a short interval so a computer that started since the last push
 * catches up. The computer consults the pushed policy on its next connection, so nothing restarts.
 */
import {
  DEFAULT_EGRESS_DESTINATIONS,
  type EgressPolicy,
  type EgressRule,
  egressDecision,
  parseEgressRules,
} from "../../../agent-computer/src/egress";
import type { NetworkPolicyRow } from "../admin/settings-store";
import type { ComputerProvider } from "./provider";

export type { EgressPolicy, EgressRule };
export { DEFAULT_EGRESS_DESTINATIONS, egressDecision, parseEgressRules };

/** No organization row at all: the computer is left as it was, which is "allow all". */
export const NO_NETWORK_POLICY: EgressPolicy = { mode: "allow_all", rules: [] };

export function effectiveNetworkPolicy(
  rows: readonly NetworkPolicyRow[],
  member: { groups: readonly string[] },
  cloudNetworkAllowed: boolean,
): EgressPolicy & { from: string } {
  if (!cloudNetworkAllowed) {
    return { mode: "deny_all", rules: [], from: "capability" };
  }
  const organization = rows.find((row) => row.scopeKind === "organization");
  if (!organization?.locked) {
    const group = rows
      .filter(
        (row) =>
          row.scopeKind === "group" && member.groups.includes(row.scopeId),
      )
      .sort((a, b) => a.scopeId.localeCompare(b.scopeId))[0];
    if (group) return { ...toPolicy(group), from: `group:${group.scopeId}` };
  }
  if (organization) return { ...toPolicy(organization), from: "organization" };
  return { ...NO_NETWORK_POLICY, from: "none" };
}

function toPolicy(row: NetworkPolicyRow): EgressPolicy {
  const parsed = parseEgressRules(row.rules);
  // A stored row that no longer parses is refused wholesale rather than half-applied.
  return parsed.ok
    ? { mode: row.mode, rules: parsed.rules }
    : { mode: "allowlist_only", rules: [] };
}

export type EgressPushReport = {
  pushed: string[];
  failed: { botId: string; reason: string }[];
};

/**
 * Push each running computer the policy its Bot's owner is under.
 *
 * Only running computers, read from `provider.list()`, which never wakes one. A computer that answers
 * 404 is running an agent-computer without the `/egress-policy` route and is reported, not retried
 * in a loop.
 */
export async function pushEgressPolicies(options: {
  provider: ComputerProvider;
  token?: string;
  policyForBot: (botId: string) => Promise<EgressPolicy>;
  fetchImpl?: typeof fetch;
}): Promise<EgressPushReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const report: EgressPushReport = { pushed: [], failed: [] };
  const computers = await options.provider.list();
  for (const computer of computers) {
    if (computer.status !== "running" || !computer.url) continue;
    try {
      const policy = await options.policyForBot(computer.botId);
      await pushEgressPolicy(computer.url, computer.botId, policy, {
        ...(options.token ? { token: options.token } : {}),
        fetchImpl,
      });
      report.pushed.push(computer.botId);
    } catch (error) {
      report.failed.push({
        botId: computer.botId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/** Push one computer one Bot's policy. Throws with the reason when the computer does not take it. */
export async function pushEgressPolicy(
  url: string,
  botId: string,
  policy: EgressPolicy,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(
    `${url.replace(/\/$/, "")}/egress-policy`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-openbot-bot-id": botId,
        ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
      },
      body: JSON.stringify({
        policy: { mode: policy.mode, rules: policy.rules },
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`the computer answered ${response.status}`);
}

/** Without a run to compare, how long a pushed policy is trusted before it is pushed again. */
const UNKNOWN_RUN_REPUSH_MS = 30_000;

/**
 * The provider, with each computer pushed its policy on the way to the action that woke it.
 *
 * A computer holds its policy in memory and refuses every connection until one arrives, so a
 * computer that has just started or resumed from suspension has none. The periodic push only
 * reaches computers `list()` already reports as running, which leaves the first actions after every
 * wake refused for up to its interval. `locate()` is on the path of every action, so the push
 * happens there, once per run of the computer: `sessionOf` names the run, and a new run (a wake, a
 * restart, an image move) is a filter starting empty. A provider that cannot name its run is
 * re-pushed at most every 30 seconds.
 *
 * A failed push is logged, never thrown: the computer refuses egress until a policy arrives, which
 * is the safe side, and the action still gets its computer.
 */
export function withPolicyPushOnWake(
  provider: ComputerProvider,
  options: {
    policyForBot: (
      botId: string,
    ) => Promise<EgressPolicy | undefined> | undefined;
    token?: string;
    fetchImpl?: typeof fetch;
  },
): ComputerProvider {
  const pushed = new Map<string, { run: string | undefined; at: number }>();
  const ensure = async (botId: string, url: string) => {
    const run = await provider.sessionOf?.(botId).catch(() => undefined);
    const last = pushed.get(botId);
    if (
      last &&
      (run !== undefined
        ? last.run === run
        : Date.now() - last.at < UNKNOWN_RUN_REPUSH_MS)
    )
      return;
    try {
      // Inside the try: reading the policy is a database call, and its failure is logged like a
      // failed push rather than failing the action.
      const policy = await options.policyForBot(botId);
      if (!policy) return;
      await pushEgressPolicy(url, botId, policy, {
        ...(options.token ? { token: options.token } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      pushed.set(botId, { run, at: Date.now() });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "egress-policy-push-on-wake-failed",
          botId,
          note: "The computer refuses its network connections until a policy reaches it.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return Object.assign(Object.create(provider) as ComputerProvider, {
    locate: async (botId: string) => {
      const url = await provider.locate(botId);
      await ensure(botId, url);
      return url;
    },
  });
}
