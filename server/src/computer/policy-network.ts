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
 * catches up. A push that does not land is tried again within seconds (`deliverEgressPolicies`), so a
 * computer that comes up after this server has its policy as soon as it answers. Each action's
 * computer is also pushed its Bot's policy on the way (`withPolicyPushOnWake`), and again after the
 * enterprise settings change. The computer consults the pushed policy on its next connection, so
 * nothing restarts, and refuses every connection until one has arrived.
 */
import {
  DEFAULT_EGRESS_DESTINATIONS,
  type EgressPolicy,
  type EgressRule,
  egressDecision,
  needsResolution,
  parseEgressRules,
} from "../../../agent-computer/src/egress";
import type { NetworkPolicyRow } from "../admin/settings-store";
import type { WebBotAuth } from "../web-bot-auth";
import { type ComputerSeat, computerKeyText, seatText } from "./computer-key";
import { computerTokenOf } from "./computer-token";
import type { ComputerLocation, ComputerProvider } from "./provider";

export type { EgressPolicy, EgressRule };
export {
  DEFAULT_EGRESS_DESTINATIONS,
  egressDecision,
  needsResolution,
  parseEgressRules,
};

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
 * A push no computer answered: it is not up yet, or cannot be reached. Not a refusal, which is an answer and says
 * something is wrong with the push itself.
 */
export class ComputerNotAnswering extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerNotAnswering";
  }
}

/**
 * The Bots a running computer carries, each of which holds a policy of its own there.
 *
 * A seat on the shared computer and an isolated Bot's computer each name their Bot. A person's
 * computer carries every Bot that person has used, and only the computer knows which, so it is asked.
 */
export async function botsOn(
  computer: ComputerLocation,
  options: { token?: string; fetchImpl: typeof fetch },
): Promise<string[]> {
  if (computer.botId) return [computer.botId];
  if (computer.key.kind === "bot") return [computer.key.botId];
  const response = await options.fetchImpl(
    `${(computer.url ?? "").replace(/\/$/, "")}/computers`,
    {
      headers: options.token
        ? { "x-openbot-computer-token": options.token }
        : {},
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`the computer answered ${response.status}`);
  const body = (await response.json().catch(() => null)) as {
    computers?: { botId?: unknown }[];
  } | null;
  return [
    ...new Set(
      (body?.computers ?? []).flatMap((seat) =>
        typeof seat.botId === "string" ? [seat.botId] : [],
      ),
    ),
  ];
}

/**
 * Push each running computer the policy each of its Bots' owners is under.
 *
 * Only running computers, read from `provider.list()`, which never wakes one. A computer that answers
 * 404 is running an agent-computer without the `/egress-policy` route and is reported. Each Bot on a
 * computer is pushed once, however many seats it has there.
 *
 * EVERY SEAT ON THE SHARED COMPUTER. There a seat's status says whether its browser is open, not
 * whether the computer is up: the list answering says it is, and the computer keeps a policy for
 * each Bot it lists, browser open or not. Pushing only the open ones left the rest on whatever they
 * held before (nothing, on a computer that came up after this server; the old policy, after an
 * administrator changed it) until each Bot's next action.
 */
export async function pushEgressPolicies(options: {
  provider: ComputerProvider;
  /** The deployment's `COMPUTER_TOKEN`; each computer is sent its own (computer-token.ts). */
  token?: string;
  policyForBot: (botId: string) => Promise<EgressPolicy>;
  webBotAuth?: WebBotAuth;
  fetchImpl?: typeof fetch;
}): Promise<EgressPushReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const report: EgressPushReport = { pushed: [], failed: [] };
  const computers = await options.provider.list();
  const everySeat = options.provider.isolation === "shared";
  const done = new Set<string>();
  for (const computer of computers) {
    if (!computer.url || (!everySeat && computer.status !== "running"))
      continue;
    const token = computerTokenOf(
      options.provider,
      computer.key,
      options.token,
    );
    let bots: string[];
    try {
      bots = await botsOn(computer, {
        ...(token ? { token } : {}),
        fetchImpl,
      });
    } catch (error) {
      report.failed.push({
        botId: computerKeyText(computer.key),
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const botId of bots) {
      const once = `${computer.url}|${botId}`;
      if (done.has(once)) continue;
      done.add(once);
      try {
        const policy = await options.policyForBot(botId);
        await pushEgressPolicy(computer.url, botId, policy, {
          ...(token ? { token } : {}),
          ...(options.webBotAuth ? { webBotAuth: options.webBotAuth } : {}),
          fetchImpl,
        });
        report.pushed.push(botId);
      } catch (error) {
        report.failed.push({
          botId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return report;
}

/**
 * Push one computer one Bot's policy. Throws with the reason when the computer does not take it, and
 * `ComputerNotAnswering` when nothing answered at all.
 *
 * The deployment's Web Bot Auth key travels in the same body when it is on, so every computer that
 * has a policy also has the key its browser signs with, and one pushed no key stops signing.
 */
export async function pushEgressPolicy(
  url: string,
  botId: string,
  policy: EgressPolicy,
  options: {
    token?: string;
    webBotAuth?: WebBotAuth;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${url.replace(/\/$/, "")}/egress-policy`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-openbot-bot-id": botId,
          ...(options.token
            ? { "x-openbot-computer-token": options.token }
            : {}),
        },
        body: JSON.stringify({
          policy: { mode: policy.mode, rules: policy.rules },
          ...(options.webBotAuth
            ? {
                webBotAuth: {
                  agent: options.webBotAuth.agent,
                  jwk: options.webBotAuth.privateJwk,
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch (error) {
    throw new ComputerNotAnswering(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) throw new Error(`the computer answered ${response.status}`);
}

/**
 * How long a policy that is not landing stays a quiet note before it is reported. The chart gives a
 * computer this long to start (its startup probe: 60 tries, 5 seconds apart), so until then the
 * likeliest reason is a computer that is simply not up yet.
 */
export const EGRESS_DELIVERY_QUIET_MS = 5 * 60_000;
/** The first quick retry of a push that did not land, doubling each time. */
const RETRY_FIRST_MS = 1_000;
/** The last quick retry. After it, the regular push every 30 seconds carries on. */
const RETRY_LAST_MS = 16_000;

/** Where the delivery's lines and timers come from. Tests pass their own; the server uses the real ones. */
export type EgressDeliveryClock = {
  quietMs?: number;
  now?: () => number;
  /** Run `run` after `ms`, and return what cancels it. */
  later?: (run: () => void, ms: number) => () => void;
  /** The quiet lines: waiting, and landed. */
  note?: (line: string) => void;
  /** The loud line, once a push has failed for longer than the quiet window. */
  report?: (line: string) => void;
};

function laterUnref(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  // Never keep the process alive for this alone.
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
}

/**
 * A push that is not landing, said the way an operator needs it said: one quiet line when it starts,
 * one loud line only if it is still failing after the quiet window, and one quiet line when it lands.
 */
function failureStreak(
  lines: { waiting: string; failed: string; landed: string },
  notes: { waiting: string; failed: string },
  clock: Required<
    Pick<EgressDeliveryClock, "quietMs" | "now" | "note" | "report">
  >,
) {
  let since: number | undefined;
  let reported = false;
  return {
    failed(fields: Record<string, unknown>) {
      if (since === undefined) {
        since = clock.now();
        clock.note(
          JSON.stringify({
            type: lines.waiting,
            ...fields,
            note: notes.waiting,
          }),
        );
        return;
      }
      if (reported || clock.now() - since < clock.quietMs) return;
      reported = true;
      clock.report(
        JSON.stringify({
          type: lines.failed,
          ...fields,
          failingForMinutes: Math.round((clock.now() - since) / 60_000),
          note: notes.failed,
        }),
      );
    },
    landed(fields: Record<string, unknown>) {
      if (since === undefined) return;
      clock.note(
        JSON.stringify({
          type: lines.landed,
          ...fields,
          waitedSeconds: Math.round((clock.now() - since) / 1_000),
        }),
      );
      since = undefined;
      reported = false;
    },
  };
}

function withDefaults(clock: EgressDeliveryClock) {
  return {
    quietMs: clock.quietMs ?? EGRESS_DELIVERY_QUIET_MS,
    now: clock.now ?? Date.now,
    later: clock.later ?? laterUnref,
    note: clock.note ?? ((line: string) => console.info(line)),
    report: clock.report ?? ((line: string) => console.error(line)),
  };
}

/**
 * Push every running computer its Bots' policies until the push lands, however this server and the
 * computers start.
 *
 * A first install starts the server and the computer side by side, and the computer's address does
 * not resolve until its pod is ready, which on the install that found this was a second after the
 * server's first push. That push was logged as an error and nothing tried again but the 30-second
 * timer. So a push that does not land is tried again after 1 second, then 2, 4, 8 and 16, and the
 * regular push carries on from there; a computer refuses every connection until its policy arrives,
 * so the gap is never an open door, only a Bot that cannot reach the network yet.
 *
 * Said quietly while it is likely a computer still starting (`EGRESS_DELIVERY_QUIET_MS`), loudly once
 * if it goes on past that, and the landing is logged, so a waiting line is never left unanswered.
 *
 * `push` calls made while one runs are folded into one more run after it, so a change saved mid-push
 * is pushed with what it changed rather than lost to the push already under way.
 */
export function deliverEgressPolicies(
  options: { push: () => Promise<EgressPushReport> } & EgressDeliveryClock,
): { push: () => Promise<void>; stop: () => void } {
  const clock = withDefaults(options);
  const streak = failureStreak(
    {
      waiting: "egress-policy-push-waiting",
      failed: "egress-policy-push-failed",
      landed: "egress-policy-delivered",
    },
    {
      waiting:
        "A computer has not taken its network policy yet, which usually means it is still starting. OpenBot pushes again within seconds, and a computer refuses its network connections until its policy arrives.",
      failed:
        "Computers have still not taken their network policies. OpenBot keeps pushing every 30 seconds, and a computer refuses its network connections until its policy arrives.",
    },
    clock,
  );
  let retryIn = RETRY_FIRST_MS;
  let cancelRetry: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const once = async () => {
    let report: EgressPushReport | undefined;
    let error: string | undefined;
    try {
      report = await options.push();
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    if (report && report.failed.length === 0) {
      streak.landed({ pushed: report.pushed });
      retryIn = RETRY_FIRST_MS;
      cancelRetry?.();
      cancelRetry = undefined;
      return;
    }
    streak.failed(
      report ? { pushed: report.pushed, failed: report.failed } : { error },
    );
    if (stopped || cancelRetry || retryIn > RETRY_LAST_MS) return;
    const wait = retryIn;
    retryIn *= 2;
    cancelRetry = clock.later(() => {
      cancelRetry = undefined;
      void push();
    }, wait);
  };

  const push = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again && !stopped);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    push,
    stop: () => {
      stopped = true;
      cancelRetry?.();
      cancelRetry = undefined;
    },
  };
}

/**
 * Push one Bot's computer its policy now, not on the way to its next action: for a change that must reach a computer
 * already pushed this run, which the push on wake (once per run) would not send again. A recording starting in the Bot's
 * browser widens its policy, and one ending narrows it back (browser/bot-browser.ts). Throws with the reason when the
 * computer does not take it; does nothing where no policy is pushed at all.
 */
export function policyPusher(options: {
  /** The Bot's computer, checked as every computer address is (the gateway's `locate`). */
  locate: (botId: string) => Promise<string>;
  policyForBot: (
    botId: string,
  ) => Promise<EgressPolicy | undefined> | undefined;
  /** The token of the Bot's computer (the gateway's `tokenFor`), never the deployment's own. */
  token?: string;
  webBotAuth?: WebBotAuth;
  fetchImpl?: typeof fetch;
}): (botId: string) => Promise<void> {
  return async (botId) => {
    const policy = await options.policyForBot(botId);
    if (!policy) return;
    await pushEgressPolicy(await options.locate(botId), botId, policy, {
      ...(options.token ? { token: options.token } : {}),
      ...(options.webBotAuth ? { webBotAuth: options.webBotAuth } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  };
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
 * Pushed again after the enterprise settings change (`forgetPushedPolicies`, which the controls call
 * on every read of them): the run alone said a computer already had its Bot's policy, so a Bot that
 * had never opened a browser, which the background push cannot see, kept the policy from before an
 * administrator narrowed it for as long as the computer ran.
 *
 * A failed push is logged, never thrown: the computer refuses egress until a policy arrives, which
 * is the safe side, and the action still gets its computer. A computer that is not answering is
 * noted quietly, once, since the action on its way there cannot reach it either and says so; a
 * computer that answers and refuses the push is a warning at once.
 */
export function withPolicyPushOnWake(
  provider: ComputerProvider,
  options: {
    policyForBot: (
      botId: string,
    ) => Promise<EgressPolicy | undefined> | undefined;
    /** The deployment's `COMPUTER_TOKEN`; each computer is sent its own (computer-token.ts). */
    token?: string;
    webBotAuth?: WebBotAuth;
    fetchImpl?: typeof fetch;
  },
): ComputerProvider {
  /*
   * Keyed by seat, not by Bot: one Bot on two people's computers is two computers, each of which
   * starts empty, and a push to one says nothing about the other.
   */
  const pushed = new Map<string, { run: string | undefined; at: number }>();
  const clock = withDefaults({ report: (line) => console.warn(line) });
  /** One per computer not answering: a computer that is down says nothing about the next one. */
  const unanswered = new Map<string, ReturnType<typeof failureStreak>>();
  const streakAt = (url: string) => {
    let streak = unanswered.get(url);
    if (!streak) {
      streak = failureStreak(
        {
          waiting: "egress-policy-push-on-wake-waiting",
          failed: "egress-policy-push-on-wake-failed",
          landed: "egress-policy-push-on-wake-delivered",
        },
        {
          waiting:
            "The computer is not answering yet. The Bot's network policy goes ahead of its next action, and the computer refuses the Bot's network connections until it arrives.",
          failed:
            "The computer refuses its network connections until a policy reaches it.",
        },
        clock,
      );
      unanswered.set(url, streak);
    }
    return streak;
  };
  const ensure = async (seat: ComputerSeat, url: string) => {
    const botId = seat.botId;
    const id = seatText(seat);
    const run = await provider.sessionOf?.(seat).catch(() => undefined);
    const last = pushed.get(id);
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
      const token = computerTokenOf(provider, seat.key, options.token);
      await pushEgressPolicy(url, botId, policy, {
        ...(token ? { token } : {}),
        ...(options.webBotAuth ? { webBotAuth: options.webBotAuth } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      pushed.set(id, { run, at: Date.now() });
      unanswered.get(url)?.landed({ botId });
      unanswered.delete(url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ComputerNotAnswering) {
        streakAt(url).failed({ botId, error: reason });
        return;
      }
      console.warn(
        JSON.stringify({
          type: "egress-policy-push-on-wake-failed",
          botId,
          note: "The computer refuses its network connections until a policy reaches it.",
          error: reason,
        }),
      );
    }
  };
  return Object.assign(Object.create(provider) as ComputerProvider, {
    locate: async (seat: ComputerSeat) => {
      const url = await provider.locate(seat);
      await ensure(seat, url);
      return url;
    },
    forgetPushedPolicies: () => pushed.clear(),
  });
}
