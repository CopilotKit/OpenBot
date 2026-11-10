/**
 * What would this network allowlist have decided, about the pages Bots already opened?
 *
 * Replay, not simulation. Every page a Bot opens is on the trail: the gateway writes a
 * `computer.action_allowed` or `computer.action_refused` row for each `computer_navigate`, with the
 * page it opened (computer/gateway.ts). Each one is judged again here by `egressDecision` itself, the
 * function the computer's network filter and the navigation check in front of it both decide with
 * (agent-computer/src/egress.ts, imported through computer/policy-network.ts). The host and port are
 * read from the page as that navigation check reads them (`destinationOf`), and the policy each Bot
 * would be under comes from `effectiveNetworkPolicy`, the function every push uses, with the
 * candidate in place of the policy it would replace.
 *
 * Page visits only. A connection a Bot's computer makes in any other way, from its shell or from a
 * page's own requests, is decided on the computer and never recorded, so it cannot be replayed. The
 * screen says so beside the answer.
 */
import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import type { AuditEvent } from "../audit";
import {
  type EgressPolicy,
  type EgressRule,
  effectiveNetworkPolicy,
  egressDecision,
  needsResolution,
} from "../computer/policy-network";
import type { Member } from "./capabilities";
import { destinationOf } from "./controls";
import type { NetworkPolicyRow } from "./settings-store";

/** The rows a page visit is recorded on, and the target they are filed under. */
export const VISIT_EVENT_TYPES = [
  "computer.action_allowed",
  "computer.action_refused",
] as const;
export const VISIT_TARGET_TYPE = "computer";

/** A network policy the admin has not saved: what the dialog holds now. */
export type CandidateNetworkPolicy = {
  scopeKind: "organization" | "group";
  scopeId: string;
  mode: NetworkPolicyRow["mode"];
  rules: EgressRule[];
  locked: boolean;
};

/** How one visit is decided under one policy. */
type Verdict = "allowed" | "blocked" | "undecided";

/** One host whose visits the candidate decides differently from the policy in force. */
export type NetworkReplayHost = {
  host: string;
  /** "block": allowed today, blocked by the candidate. "allow": the other way round. */
  change: "block" | "allow";
  visits: number;
  /** The Bots that made them, by id. */
  bots: string[];
  lastVisit: string;
};

export type NetworkReplayReport = {
  /** Page visits read from the trail. */
  scanned: number;
  /**
   * Of those, the visits by Bots this policy would cover. A group's policy covers its members' Bots,
   * the organization's covers the rest (or everybody's when it is locked), and a Bot whose owner
   * has network access turned off is covered by neither.
   */
  covered: number;
  /** Allowed by the policy in force, blocked by the candidate. */
  wouldBlock: number;
  /** Blocked by the policy in force, allowed by the candidate. */
  wouldAllow: number;
  /**
   * A named host that only an IP range could allow, under either policy. The computer decides those
   * with the address the name resolves to there, which the trail does not record, so they are not
   * counted either way.
   */
  undecided: number;
  unchanged: number;
  /** Changed visits by host, most visits first. Capped; the counts cover every visit. */
  hosts: NetworkReplayHost[];
  /** How many hosts changed in all, listed or not. */
  sites: number;
};

/** Hosts returned in full. The counts still cover every visit. */
const HOSTS_CAP = 25;

function verdictOf(policy: EgressPolicy, host: string, port: number): Verdict {
  if (egressDecision(policy, host, port).allowed) return "allowed";
  return needsResolution(policy, host) ? "undecided" : "blocked";
}

/** The `from` an effective policy carries when it is this candidate's. */
function scopeName(candidate: CandidateNetworkPolicy): string {
  return candidate.scopeKind === "organization"
    ? "organization"
    : `group:${candidate.scopeId}`;
}

/** The policies in force, with the candidate in place of the one it would replace. */
export function withCandidate(
  rows: readonly NetworkPolicyRow[],
  candidate: CandidateNetworkPolicy,
): NetworkPolicyRow[] {
  return [
    ...rows.filter(
      (row) =>
        row.scopeKind !== candidate.scopeKind ||
        row.scopeId !== candidate.scopeId,
    ),
    {
      scopeKind: candidate.scopeKind,
      scopeId: candidate.scopeId,
      mode: candidate.mode,
      rules: candidate.rules,
      locked: candidate.scopeKind === "organization" && candidate.locked,
      updatedBy: null,
      updatedAt: new Date(0).toISOString(),
    },
  ];
}

/** The Bots whose visits these rows record, for looking up whose policy each is under. */
export function visitingBots(events: readonly AuditEvent[]): string[] {
  return [
    ...new Set(
      events.flatMap((event) => {
        const bot = event.payload.bot;
        return typeof bot === "string" && bot && !isPersonBrowserId(bot)
          ? [bot]
          : [];
      }),
    ),
  ];
}

/**
 * Replay page visits under a candidate network policy and report what changes from the policy in
 * force.
 *
 * Both sides are decided the same way, now: by `egressDecision` under the policy each Bot's owner
 * would be under, with the rows in force and with the candidate in their place. So a visit refused
 * last month by a list since widened, and still allowed by the candidate, is unchanged, and the
 * answer is what saving the candidate changes, not what happened at the time.
 *
 * `owners` is each Bot's owner and whether their network access is on (`networkMemberFor`). A Bot
 * missing from it is skipped: its owner could not be read, and guessing would count it under a
 * policy it may not be under.
 */
export function replayNetworkPolicy(input: {
  candidate: CandidateNetworkPolicy;
  rows: readonly NetworkPolicyRow[];
  events: readonly AuditEvent[];
  owners: ReadonlyMap<string, { member: Member; cloudNetwork: boolean }>;
}): NetworkReplayReport {
  const report: NetworkReplayReport = {
    scanned: 0,
    covered: 0,
    wouldBlock: 0,
    wouldAllow: 0,
    undecided: 0,
    unchanged: 0,
    hosts: [],
    sites: 0,
  };
  const candidateRows = withCandidate(input.rows, input.candidate);
  const scope = scopeName(input.candidate);
  const hosts = new Map<string, NetworkReplayHost>();

  for (const event of input.events) {
    if (
      !(VISIT_EVENT_TYPES as readonly string[]).includes(event.eventType) ||
      event.payload.action !== "computer_navigate"
    )
      continue;
    const bot = event.payload.bot;
    const page = event.payload.page;
    // A person's own browser is under its own policy (browser/egress.ts), never this one.
    if (typeof bot !== "string" || !bot || isPersonBrowserId(bot)) continue;
    const destination =
      typeof page === "string" && page ? destinationOf(page) : null;
    if (!destination) continue;
    report.scanned += 1;

    const owner = input.owners.get(bot);
    if (!owner) continue;
    const next = effectiveNetworkPolicy(
      candidateRows,
      owner.member,
      owner.cloudNetwork,
    );
    if (next.from !== scope) continue;
    report.covered += 1;
    const now = effectiveNetworkPolicy(
      input.rows,
      owner.member,
      owner.cloudNetwork,
    );

    const was = verdictOf(now, destination.host, destination.port);
    const would = verdictOf(next, destination.host, destination.port);
    if (was === "undecided" || would === "undecided") {
      report.undecided += 1;
      continue;
    }
    if (was === would) {
      report.unchanged += 1;
      continue;
    }
    const change = would === "blocked" ? "block" : "allow";
    if (change === "block") report.wouldBlock += 1;
    else report.wouldAllow += 1;

    const key = `${change} ${destination.host}`;
    const seen = hosts.get(key);
    if (seen) {
      seen.visits += 1;
      if (!seen.bots.includes(bot)) seen.bots.push(bot);
      if (event.createdAt > seen.lastVisit) seen.lastVisit = event.createdAt;
    } else {
      hosts.set(key, {
        host: destination.host,
        change,
        visits: 1,
        bots: [bot],
        lastVisit: event.createdAt,
      });
    }
  }

  report.hosts = [...hosts.values()]
    .sort(
      (a, b) =>
        b.visits - a.visits ||
        b.lastVisit.localeCompare(a.lastVisit) ||
        a.host.localeCompare(b.host),
    )
    .slice(0, HOSTS_CAP);
  report.sites = hosts.size;
  return report;
}
