import { describe, expect, test } from "bun:test";
import {
  createHandoffDesk,
  HANDOFF_KIND,
  type HandoffCaps,
} from "../src/agents/handoff";
import type {
  AgentProfile,
  AgentProfileStore,
} from "../src/agents/profile-store";
import type { AuditStore } from "../src/audit";
import type { WorkQueue } from "../src/work/queue";

/**
 * One Bot handing work to another, and the four things that must never happen.
 *
 * A loop that bills for every hop. A fan-out that wakes four sleeping computers because one Bot was
 * chatty. A Bot reaching a Bot its person cannot see. And a Bot reaching one nobody granted it.
 *
 * Every refusal is an answer rather than an exception, because the asking Bot is mid-run with a
 * person waiting: a throw ends the run with nothing said, which reads as the Bot ignoring them.
 */

const CAPS: HandoffCaps = { maxDepth: 2, maxPerRun: 3 };

function profile(over: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    name: over.id,
    title: "",
    roleDescription: "",
    avatarSeed: over.id,
    visibility: "public",
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: false,
    canManage: false,
    mine: false,
    ownerUserId: null,
    deletedAt: null,
    ...over,
  } as AgentProfile;
}

function desk(options?: {
  roster?: AgentProfile[];
  granted?: boolean;
  offered?: number;
  caps?: HandoffCaps;
  role?: "admin" | "user";
}) {
  const rows: Array<{ kind: string; key: string; payload: unknown }> = [];
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> =
    [];

  const queue = {
    offer: async (item: {
      kind: string;
      key: string;
      payload?: unknown;
      atMost?: { keyPrefix: string; max: number };
    }) => {
      // Idempotent on the key, exactly as the real one is — and it says so, because "already
      // there" and "just queued" are different answers to the caller.
      if (rows.some((row) => row.key === item.key)) return "already";
      // And the cap, counted and written as one step, exactly as the real one is.
      if (item.atMost && (options?.offered ?? rows.length) >= item.atMost.max) {
        return "refused";
      }
      rows.push({ kind: item.kind, key: item.key, payload: item.payload });
      return "queued";
    },
  } as unknown as WorkQueue;

  const profiles = {
    list: async () =>
      options?.roster ?? [profile({ id: "researcher", name: "Researcher" })],
  } as unknown as AgentProfileStore;

  const recorded = events;
  const auditStore: AuditStore = {
    insert: async (event) => {
      recorded.push({
        eventType: event.eventType,
        payload: event.payload ?? {},
      });
    },
  };

  return {
    rows,
    events: recorded,
    desk: createHandoffDesk({
      queue,
      profiles,
      mayAddress: async () => options?.granted ?? true,
      actorFor: async (id: string) => ({
        id,
        role: options?.role ?? ("user" as const),
      }),
      auditStore,
      caps: options?.caps ?? CAPS,
    }),
  };
}

const FROM = {
  botId: "assistant",
  actorId: "user-1",
  runId: "run-1",
  threadId: "thread-1",
  depth: 0,
};

describe("handing work to another Bot", () => {
  test("an allowed hop becomes one durable row", async () => {
    const { desk: handoff, rows } = desk();

    const outcome = await handoff.send({
      from: FROM,
      target: "Researcher",
      envelope: { task: "find the outage window", expecting: "a date range" },
    });

    expect(outcome).toMatchObject({ ok: true, to: "researcher" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe(HANDOFF_KIND);
    expect(rows[0]?.payload).toMatchObject({
      fromBotId: "assistant",
      toBotId: "researcher",
      actorId: "user-1",
      // One deeper than the run that asked, so the cap keeps counting across pods.
      depth: 1,
    });
  });

  /*
   * The key is what stops a retried delivery running the other Bot twice, so the same envelope sent
   * twice in one run has to land on the same key. A fresh id per attempt is at-least-once with no
   * ceiling.
   */
  test("the same request twice in one run is one hop", async () => {
    const { desk: handoff, rows } = desk();
    const send = () =>
      handoff.send({
        from: FROM,
        target: "researcher",
        envelope: { task: "find the outage window" },
      });

    await send();
    await send();

    expect(rows).toHaveLength(1);
  });

  test("a different request in the same run is a different hop", async () => {
    const { desk: handoff, rows } = desk();

    await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "find the outage window" },
    });
    await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "find who was on call" },
    });

    expect(rows).toHaveLength(2);
  });

  /* A asks B asks C asks A, which is the obvious failure and spends real money going round. */
  test("a chain already at the depth cap is refused", async () => {
    const { desk: handoff, rows } = desk();

    const outcome = await handoff.send({
      from: { ...FROM, depth: 2 },
      target: "researcher",
      envelope: { task: "keep going" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  test("a deployment with a depth cap of zero allows no hop at all", async () => {
    const { desk: handoff, rows } = desk({
      caps: { maxDepth: 0, maxPerRun: 3 },
    });

    const outcome = await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "anything" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  /* Counted from the rows rather than a variable, because the hops land on several pods. */
  test("a run that has already asked its limit is refused", async () => {
    const { desk: handoff, rows } = desk({ offered: 3 });

    const outcome = await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "one more" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  /*
   * Resolved against the roster the asking PERSON may see. Otherwise a Bot names anything and the
   * deployment goes and finds it, which is a way around agent visibility.
   */
  test("a Bot the person cannot see cannot be reached", async () => {
    const { desk: handoff, rows } = desk({ roster: [] });

    const outcome = await handoff.send({
      from: FROM,
      target: "payroll",
      envelope: { task: "what is everyone paid" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  /*
   * And it reads the same as one that does not exist. Two different sentences would let a Bot
   * enumerate the roster by asking for names and reading which refusal came back.
   */
  test("an unreachable Bot and a missing one are refused in the same words", async () => {
    const hidden = await desk({
      roster: [profile({ id: "payroll", name: "Payroll", hidden: true })],
    }).desk.send({
      from: FROM,
      target: "Payroll",
      envelope: { task: "t" },
    });
    const missing = await desk({ roster: [] }).desk.send({
      from: FROM,
      target: "Payroll",
      envelope: { task: "t" },
    });

    expect(hidden.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect((hidden as { refusal: string }).refusal).toBe(
      (missing as { refusal: string }).refusal,
    );
  });

  test("a Bot nobody granted cannot be reached", async () => {
    const { desk: handoff, rows } = desk({ granted: false });

    const outcome = await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "have a look" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  test("a Bot cannot hand work to itself", async () => {
    const { desk: handoff, rows } = desk({
      roster: [profile({ id: "assistant", name: "Assistant" })],
    });

    const outcome = await handoff.send({
      from: FROM,
      target: "assistant",
      envelope: { task: "do it again" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  test("a hop with nothing asked is refused", async () => {
    const { desk: handoff, rows } = desk();

    const outcome = await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "   " },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });

  /*
   * The refused row matters more than the accepted one. A hop that happened shows in the transcript;
   * a hop that was refused is invisible everywhere else, and "why did it not ask the specialist" is
   * the question somebody asks about a thin answer.
   */
  test("both outcomes leave a row naming the run and the reason", async () => {
    const allowed = desk();
    await allowed.desk.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "t" },
    });
    expect(allowed.events.map((event) => event.eventType)).toEqual([
      "agent.handoff_offered",
    ]);
    expect(allowed.events[0]?.payload).toMatchObject({
      from: "assistant",
      to: "researcher",
      run: "run-1",
    });

    const refused = desk({ granted: false });
    await refused.desk.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "t" },
    });
    expect(refused.events.map((event) => event.eventType)).toEqual([
      "agent.handoff_refused",
    ]);
    expect(refused.events[0]?.payload).toMatchObject({
      reason: "not_granted",
      run: "run-1",
    });
  });
});

/*
 * Where the answer goes comes from the signed assertion, never from the model. A Bot naming its own
 * thread would be a Bot able to drop a turn into a conversation it was never part of.
 */
describe("where a hop's answer lands", () => {
  test("comes from the assertion", async () => {
    const { desk: handoff, rows } = desk();

    await handoff.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "t" },
    });

    expect(rows[0]?.payload).toMatchObject({ threadId: "thread-1" });
  });

  test("a run with no conversation cannot hand work on", async () => {
    const { desk: handoff, rows } = desk();

    const outcome = await handoff.send({
      from: { ...FROM, threadId: undefined },
      target: "researcher",
      envelope: { task: "t" },
    });

    expect(outcome.ok).toBe(false);
    expect(rows).toEqual([]);
  });
});

/**
 * Two Bots with one name.
 *
 * `agents.name` has no unique constraint and duplicating a Bot deliberately makes a second with the
 * same name, so a person can be looking at two called Knowledge. Taking whichever sorted first sends
 * the work to a Bot nobody meant, or refuses a legitimate hop as "not granted" because the other
 * twin is the granted one. Neither says a word about there having been two.
 */
describe("a name that means more than one Bot", () => {
  test("is refused, naming the ids to choose between", async () => {
    const twins = desk({
      roster: [
        profile({ id: "knowledge-a", name: "Knowledge" }),
        profile({ id: "knowledge-b", name: "Knowledge" }),
      ],
    });

    const outcome = await twins.desk.send({
      from: FROM,
      target: "Knowledge",
      envelope: { task: "find the policy" },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal).toContain("knowledge-a");
      expect(outcome.refusal).toContain("knowledge-b");
    }
    expect(
      twins.events.map((event) => ({
        eventType: event.eventType,
        reason: (event.payload as { reason?: string }).reason,
      })),
    ).toEqual([
      { eventType: "agent.handoff_refused", reason: "ambiguous_bot" },
    ]);
  });

  test("but the id still reaches exactly the one it names", async () => {
    const twins = desk({
      roster: [
        profile({ id: "knowledge-a", name: "Knowledge" }),
        profile({ id: "knowledge-b", name: "Knowledge" }),
      ],
    });

    const outcome = await twins.desk.send({
      from: FROM,
      target: "knowledge-b",
      envelope: { task: "find the policy" },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.to).toBe("knowledge-b");
  });
});

/**
 * Whose roster the target is resolved against.
 *
 * An administrator sees Bots a user does not. Assumed to be a user, an administrator'"'"'s hop to a Bot
 * they can see and chat with in the UI was refused as "no such Bot" — the same failure `index.ts`
 * warns about for a routine'"'"'s owner.
 */
describe("the role a hop is resolved as", () => {
  test("is asked for rather than assumed", async () => {
    const asked: Array<{ id: string; role: string }> = [];
    const profiles = {
      list: async (actor: { id: string; role: string }) => {
        asked.push(actor);
        return [profile({ id: "researcher", name: "Researcher" })];
      },
    } as unknown as AgentProfileStore;

    const built = createHandoffDesk({
      queue: {
        offer: async () => "queued",
      } as unknown as WorkQueue,
      profiles,
      mayAddress: async () => true,
      actorFor: async (id) => ({ id, role: "admin" }),
      auditStore: { insert: async () => {} },
      caps: CAPS,
    });

    await built.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "find it" },
    });

    expect(asked).toEqual([{ id: "user-1", role: "admin" }]);
  });
});

/**
 * Asking for the same thing twice.
 *
 * `offer` is idempotent on the key, so a model repeating itself inside one run leaves one hop, which
 * is the intent. What must not happen is being told "handed over" a second time: the row it names
 * may already have been delivered and finished, so nothing is queued, nobody is going to run it, and
 * the Bot has just promised the person an answer twice.
 */
describe("the same ask a second time", () => {
  test("is refused plainly rather than reported as handed over", async () => {
    const twice = desk();

    const first = await twice.desk.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "find the outage window" },
    });
    const second = await twice.desk.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "find the outage window" },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.refusal).toContain("already asked");
      // Not a claim about when: the run id arrives on the request, so "this turn" can be false.
      expect(second.refusal).not.toContain("this turn");
    }
    // One row, and one refusal on the trail beside the offer.
    expect(twice.rows).toHaveLength(1);
    expect(
      twice.events.map((event) => ({
        eventType: event.eventType,
        reason: (event.payload as { reason?: string }).reason,
      })),
    ).toEqual([
      { eventType: "agent.handoff_offered", reason: undefined },
      { eventType: "agent.handoff_refused", reason: "duplicate" },
    ]);
  });

  /*
   * A role that cannot be read is not a role. Everything in this module answers with a sentence, so
   * a seam that throws would end the run with nothing said at all.
   */
  test("a person whose role cannot be established is refused, not thrown at", async () => {
    const unknown = createHandoffDesk({
      queue: { offer: async () => "queued" } as unknown as WorkQueue,
      profiles: {
        list: async () => [profile({ id: "researcher", name: "Researcher" })],
      } as unknown as AgentProfileStore,
      mayAddress: async () => true,
      actorFor: async () => null,
      auditStore: { insert: async () => {} },
      caps: CAPS,
    });

    const outcome = await unknown.send({
      from: FROM,
      target: "researcher",
      envelope: { task: "find it" },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.refusal).toContain("could not be confirmed");
  });
});
