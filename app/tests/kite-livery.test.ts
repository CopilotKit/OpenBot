import { describe, expect, test } from "bun:test";
import { KITE_PATTERNS } from "@/components/agents/kite/kite-draw";
import { botLivery } from "@/components/agents/kite/livery";
import { kiteStateOf } from "@/components/bot-profile/attention";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";

/*
 * A Bot's livery comes from its seed (`avatarSeed`, the Bot's id by default), never its name, so
 * renaming a Bot keeps its look.
 */

/*
 * Each seed's palette index under the orb this replaced (`orbPalette` on main before the kite), so
 * no Bot changes colour when its orb becomes a kite.
 */
const ORB_SLOTS: Record<string, number> = {
  "general-assistant": 6,
  knowledge: 3,
  "risk-analyst": 1,
  "expense-review": 6,
  "research-desk": 6,
  "meeting-follow-ups": 3,
  "release-notes": 6,
  "onboarding-buddy": 5,
  "ticket-triage": 0,
  "vendor-review": 2,
};
const SEEDS = Object.keys(ORB_SLOTS);

describe("botLivery", () => {
  test("every Bot keeps the colour slot its orb had", () => {
    for (const seed of SEEDS)
      expect(botLivery(seed).slot).toBe(ORB_SLOTS[seed]);
  });

  test("the same seed always gives the same livery", () => {
    for (const seed of SEEDS) expect(botLivery(seed)).toEqual(botLivery(seed));
  });

  test("every pattern is one of the eight sail patterns", () => {
    for (const seed of SEEDS)
      expect(KITE_PATTERNS).toContain(botLivery(seed).pattern);
  });

  test("Bots that share a colour are still told apart by their sail", () => {
    const sixes = SEEDS.filter((seed) => ORB_SLOTS[seed] === 6);
    expect(sixes.length).toBeGreaterThan(1);
    expect(
      new Set(sixes.map((seed) => botLivery(seed).pattern)).size,
    ).toBeGreaterThan(1);
  });

  test("two Bots never blink on the same seed by accident of colour", () => {
    expect(new Set(SEEDS.map((seed) => botLivery(seed).seed)).size).toBe(
      SEEDS.length,
    );
  });

  test("no seed has no identity: the first colour and a plain sail", () => {
    expect(botLivery("")).toEqual({ slot: 0, pattern: "solid", seed: 1 });
  });
});

describe("kiteStateOf", () => {
  const bot = (over: Partial<BotAttention> = {}): BotAttention => ({
    agentId: "a",
    name: "A",
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
    ...over,
  });
  const tasks = (over: Partial<BotAttention["tasks"]>) => ({
    tasks: { needsInput: 0, ready: 0, failed: 0, ...over },
  });

  test("a Bot with nothing waiting is idle, as is one the list has not loaded", () => {
    expect(kiteStateOf(bot())).toBe("idle");
    expect(kiteStateOf(undefined)).toBe("idle");
  });

  test("anything only the person can answer is Waiting for you", () => {
    expect(kiteStateOf(bot({ questions: 1 }))).toBe("waiting");
    expect(kiteStateOf(bot({ approvals: 2 }))).toBe("waiting");
    expect(kiteStateOf(bot({ handoffs: 1 }))).toBe("waiting");
    expect(kiteStateOf(bot(tasks({ needsInput: 1 })))).toBe("waiting");
  });

  test("a failed task is an error, a reply to read is done", () => {
    expect(kiteStateOf(bot(tasks({ failed: 1 })))).toBe("error");
    expect(kiteStateOf(bot(tasks({ ready: 1 })))).toBe("done");
  });

  test("a paused Bot sleeps, unless it is still waiting on the person or has failed", () => {
    expect(kiteStateOf(bot({ paused: true }))).toBe("sleeping");
    expect(kiteStateOf(bot({ paused: true, ...tasks({ ready: 1 }) }))).toBe(
      "sleeping",
    );
    expect(kiteStateOf(bot({ paused: true, questions: 1 }))).toBe("waiting");
    expect(kiteStateOf(bot({ paused: true, ...tasks({ failed: 1 }) }))).toBe(
      "error",
    );
  });

  test("what its check-ins found never changes the kite", () => {
    expect(kiteStateOf(bot({ items: 3 }))).toBe("idle");
    expect(kiteStateOf(bot({ unread: 4 }))).toBe("idle");
  });
});
