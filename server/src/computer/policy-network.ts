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
      const response = await fetchImpl(
        `${computer.url.replace(/\/$/, "")}/egress-policy`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-openbot-bot-id": computer.botId,
            ...(options.token
              ? { "x-openbot-computer-token": options.token }
              : {}),
          },
          body: JSON.stringify({
            policy: { mode: policy.mode, rules: policy.rules },
          }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        report.failed.push({
          botId: computer.botId,
          reason: `the computer answered ${response.status}`,
        });
        continue;
      }
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
