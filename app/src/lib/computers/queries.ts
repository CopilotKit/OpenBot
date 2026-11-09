import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One computer as Admin sees it: a person's, or an isolated Bot's.
 *
 * On a deployment with one shared computer, each entry is one person's seat on one Bot there, and
 * names both.
 */
export type ComputerProfile = {
  /** Whose computer, as `person:<id>` or `bot:<id>`. What the stop, reset and update calls name. */
  computer: string;
  kind: "person" | "bot";
  personId?: string;
  /** The person's name and address, where the deployment knows them. */
  person?: { name: string | null; email: string };
  /** The isolated Bot, or the Bot of one seat on the shared computer. */
  botId?: string;
  running: boolean;
  startedAt: string | null;
  /** Absent when the provider does not report egress at all, which is not the same as none. */
  egress?: string | null;
  /** True when it runs an older image than a new computer would. Absent where that cannot be told. */
  updateAvailable?: boolean;
};

/** One computer per person (and per isolated Bot), or one computer every person's Bots share. */
export type ComputerIsolation = "per-person" | "shared";

/** What the list endpoint answers: the computers, and how they are separated. */
export type ComputerFleet = {
  computers: ComputerProfile[];
  isolation?: ComputerIsolation;
};

/**
 * Whether the boundary acts on its verdict.
 *
 * `dry-run` records what it would have refused without refusing it, which is how a policy is tried
 * out before it stops a Bot mid-task.
 */
export type PolicyMode = "dry-run" | "enforce";

/** The rules a Bot's actions are judged against. */
export type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
  /** Each rule's name and what it stops, keyed by the rule's text. Display only. */
  labels?: Record<string, RuleLabel>;
};

export type RuleLabel = { name: string; description: string };

/**
 * Where one Bot's computer is in its life, as the server's provider reports it.
 *
 * `absent` is a computer that is not running: never started, or put to sleep after a quiet spell.
 * Either way it starts on the Bot's next computer action, so it is not a fault. `starting` is on its
 * way up. `unreachable` is the only one that is something wrong.
 */
export type ComputerState = "absent" | "starting" | "ready" | "unreachable";

export type ComputerStatus = {
  botId: string;
  state: ComputerState;
  /** Set when `state` is `unreachable`. Written for an admin, so not shown on a screen anybody can open. */
  reason?: string;
};

export const computerKeys = {
  all: ["computers"] as const,
  fleet: () => ["computers", "fleet"] as const,
  policy: () => ["computers", "policy"] as const,
  dryRun: (candidate: ActionPolicy) =>
    ["computers", "policy", "dry-run", candidate] as const,
  status: (botId: string) => ["computers", "status", botId] as const,
};

/**
 * One Bot's computer's state, read without waking it.
 *
 * The status route reads the provider's own record of the computer and never dials it, which is what
 * makes it safe to poll while somebody is watching a computer start: asking for a screenshot instead
 * went through the path that resumes a sleeping computer, so looking was enough to start it.
 */
export function computerStatusQueryOptions(botId: string) {
  return queryOptions({
    queryKey: computerKeys.status(botId),
    queryFn: (): Promise<ComputerStatus> =>
      client(`/api/computers/${encodeURIComponent(botId)}/status`, {
        fallback: "Couldn't check the computer.",
      }).then((response) => response.json()),
  });
}

/**
 * The deployment-wide fleet route.
 *
 * Not a Bot id in a member route, which is what this used to be. That placeholder stopped working
 * when the server began checking whether the caller may act as the Bot in the path: a placeholder
 * is not a Bot, so the list 404d and this screen showed nothing at all.
 */
const FLEET_PATH = "/api/computers/fleet";

/** No envelope key: the body carries both the list and the isolation mode. */
export function computerFleetQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.fleet(),
    queryFn: async (): Promise<ComputerFleet> => {
      const response = await client(FLEET_PATH, {
        fallback: "The computers could not be listed.",
      });
      return response.json();
    },
  });
}

export function actionPolicyQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.policy(),
    queryFn: (): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        fallback: "The boundary could not be read.",
      }),
  });
}

/** One recorded action a candidate policy would decide differently than what happened. */
export type DryRunChange = {
  id: string;
  createdAt: string;
  /** A Bot's computer action, or a call to a tool on an app. */
  kind: "computer" | "app";
  /** The computer's tool (`computer_click`), or the app's tool as `<app>/<tool>`. */
  action: string;
  bot: string;
  page: string;
  element: { role: string; name: string } | null;
  command: string | null;
  file: string | null;
  /** What started the run: a person, a routine, a handoff. */
  initiator: { kind: string; id: string };
  was: "allowed" | "refused";
  would: "allowed" | "refused";
  rule: string | null;
  reason: string;
};

export type DryRunReport = {
  scanned: number;
  wouldRefuse: number;
  wouldAllow: number;
  unchanged: number;
  /** Capped by the server; the counts cover everything scanned. */
  changes: DryRunChange[];
};

/**
 * What would this policy have decided, about recent recorded actions: a Bot's computer actions and
 * its app calls alike?
 *
 * It writes nothing, not the policy and no audit row. A rule that can't be evaluated is refused with
 * the server's sentence saying why, and nothing is replayed.
 */
export async function dryRunActionPolicy(
  candidate: ActionPolicy,
): Promise<DryRunReport> {
  return client("/api/computers/policy-dry-run", "report", {
    method: "POST",
    body: { policy: candidate },
    fallback: "The rule could not be tested against history.",
  });
}

/**
 * The dry-run of one candidate, as a query, so a screen can run it as a rule is typed.
 *
 * Keyed by the candidate itself: the answer is about those rules and nothing else, and typing back to
 * a rule already tried answers from the cache. A rule that doesn't compile is an answer, not a fault,
 * so it is not retried.
 */
export function policyDryRunQueryOptions(candidate: ActionPolicy) {
  return queryOptions({
    queryKey: computerKeys.dryRun(candidate),
    queryFn: (): Promise<DryRunReport> => dryRunActionPolicy(candidate),
    retry: false,
  });
}
