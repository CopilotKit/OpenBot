import { describe, expect, test } from "bun:test";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AuditStore } from "../src/audit";
import type {
  IntentRouter,
  RoutingCandidate,
  RoutingUndecided,
} from "../src/routing/classify";
import {
  createCoworkerRoutingService,
  normalizeCoworkerName,
} from "../src/routing/service";

const ACTOR = { id: "u1", role: "user" } as const;

function profile(
  id: string,
  name: string,
  visibility: "public" | "private" = "public",
  ownerUserId: string | null = null,
): AgentProfile {
  return {
    id,
    name,
    title: name,
    roleDescription: `${name} work`,
    avatarSeed: id,
    visibility,
    ownerUserId,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
  };
}

function makeService(
  options: {
    roster?: AgentProfile[];
    decision?: {
      agentId: string;
      reason: string;
      fallback: boolean;
      undecided: RoutingUndecided | null;
    };
    reachableSystems?: (agentId: string) => Promise<readonly string[]>;
  } = {},
) {
  const roster = options.roster ?? [
    profile("risk", "Risk Analyst"),
    profile("knowledge", "Knowledge"),
  ];
  const modelCalls: Array<{
    text: string;
    candidates: readonly RoutingCandidate[];
    defaultId: string;
  }> = [];
  const audits: Array<{
    payload: Record<string, unknown>;
    targetId: string | null;
  }> = [];
  const store = { list: async () => roster } as unknown as AgentProfileStore;
  const router = {
    route: async (
      text: string,
      candidates: readonly RoutingCandidate[],
      defaultId: string,
    ) => {
      modelCalls.push({ text, candidates, defaultId });
      const selected = options.decision ?? {
        agentId: "knowledge",
        reason: "matches what it is for",
        fallback: false,
        undecided: null,
      };
      const candidate = candidates.find(({ id }) => id === selected.agentId);
      return { ...selected, name: candidate?.name ?? selected.agentId };
    },
  } as unknown as IntentRouter;
  const auditStore = {
    insert: async (event: {
      payload: Record<string, unknown>;
      targetId: string | null;
    }) => {
      audits.push(event);
    },
  } as unknown as AuditStore;

  return {
    service: createCoworkerRoutingService({
      store,
      router,
      auditStore,
      reachableSystems: options.reachableSystems,
    }),
    modelCalls,
    audits,
  };
}

describe("CoworkerRoutingService", () => {
  test("refuses empty service input before asking the model", async () => {
    const { service, modelCalls, audits } = makeService();
    for (const text of ["", "   "]) {
      await expect(service.route({ actor: ACTOR, text })).rejects.toThrow(
        "A message is required.",
      );
    }
    expect(modelCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("refuses oversized text before any routing, including picker selections", async () => {
    const { service, modelCalls, audits } = makeService();
    for (const agentId of [undefined, "risk"]) {
      await expect(
        service.route({ actor: ACTOR, text: "x".repeat(10001), agentId }),
      ).rejects.toThrow("A message of at most 10000 characters is required.");
    }
    expect(modelCalls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("accepts text at the routing limit", async () => {
    const { service, modelCalls } = makeService();
    await service.route({ actor: ACTOR, text: "x".repeat(10000) });
    expect(modelCalls[0]?.text).toHaveLength(10000);
  });

  test("distinguishes name inference from picker selection in the audit", async () => {
    const { service, audits, modelCalls } = makeService();
    await service.route({
      actor: ACTOR,
      text: "ask Risk Analyst to review this",
    });
    await service.route({ actor: ACTOR, text: "review this", agentId: "risk" });
    expect(audits[0]?.payload).toMatchObject({
      reason: "matched a coworker’s name in the message",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(audits[1]?.payload).toMatchObject({
      reason: "named by the person asking",
      viaMention: true,
      viaNameMatch: false,
    });
    expect(modelCalls).toEqual([]);
  });

  test("a name that ends another coworker's name addresses only its own coworker", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("analyst", "Analyst"), profile("risk", "Risk Analyst")],
    });
    expect(
      await service.route({ actor: ACTOR, text: "ask analyst" }),
    ).toMatchObject({
      kind: "selected",
      agentId: "analyst",
      viaNameMatch: true,
    });
    expect(
      await service.route({ actor: ACTOR, text: "ask risk analyst" }),
    ).toMatchObject({ kind: "selected", agentId: "risk", viaNameMatch: true });
    expect(modelCalls).toEqual([]);
  });
  test("an issued discriminator label refuses a later coworker given that exact name", async () => {
    const roster = [
      profile("a", "Risk Analyst"),
      profile("b", "Risk Analyst"),
      profile("c", "Risk Analyst (id 61)"),
    ];
    const { service } = makeService({ roster });
    const label = "Risk Analyst (id 61) (2)";
    expect(
      await service.route({ actor: ACTOR, text: `ask ${label}` }),
    ).toMatchObject({ kind: "selected", agentId: "a" });
    roster.push(profile("d", label));
    const result = await service.route({ actor: ACTOR, text: `ask ${label}` });
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("Expected ambiguity");
    for (const choice of result.names) {
      expect(
        await service.route({ actor: ACTOR, text: `ask ${choice}` }),
      ).toMatchObject({ kind: "selected" });
    }
  });
  test("an issued id label cannot silently change recipient after a roster collision", async () => {
    const roster = [profile("a", "Risk Analyst"), profile("b", "Risk Analyst")];
    const { service } = makeService({ roster });
    const label = "Risk Analyst (id 61)";
    expect(
      await service.route({ actor: ACTOR, text: `ask ${label}` }),
    ).toMatchObject({ kind: "selected", agentId: "a" });
    // A coworker whose name merely ends with the label is a different name and changes nothing.
    roster.push(profile("c", "Senior Risk Analyst (id 61)"));
    expect(
      await service.route({ actor: ACTOR, text: `ask ${label}` }),
    ).toMatchObject({ kind: "selected", agentId: "a" });
    // One given the label as its exact name makes the label ambiguous rather than switch recipient.
    roster.splice(2, 1, profile("c", label));
    const result = await service.route({ actor: ACTOR, text: `ask ${label}` });
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("Expected ambiguity");
    for (const choice of result.names) {
      expect(
        await service.route({ actor: ACTOR, text: `ask ${choice}` }),
      ).toMatchObject({ kind: "selected" });
    }
  });
  test("duplicate labels remain unique beside a coworker whose literal name resembles a label", async () => {
    const { service } = makeService({
      roster: [
        profile("a", "Risk Analyst"),
        profile("b", "Risk Analyst"),
        profile("c", "Risk Analyst (id 61)"),
      ],
    });
    const result = await service.route({
      actor: ACTOR,
      text: "ask Risk Analyst",
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("Expected ambiguity");
    expect(new Set(result.names).size).toBe(result.names.length);
    for (const name of result.names) {
      expect(
        await service.route({ actor: ACTOR, text: `ask ${name}` }),
      ).toMatchObject({ kind: "selected" });
    }
  });

  test("duplicate labels remain unique beside a coworker whose suffix alias resembles a label", async () => {
    const { service } = makeService({
      roster: [
        profile("a", "Risk Analyst"),
        profile("b", "Risk Analyst"),
        profile("c", "Senior Risk Analyst (id 61)"),
      ],
    });
    const result = await service.route({
      actor: ACTOR,
      text: "ask Risk Analyst",
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("Expected ambiguity");
    expect(new Set(result.names).size).toBe(result.names.length);
    for (const name of result.names) {
      expect(
        await service.route({ actor: ACTOR, text: `ask ${name}` }),
      ).toMatchObject({ kind: "selected" });
    }
  });

  test("routes a unique explicit coworker name without invoking the model", async () => {
    const { service, modelCalls } = makeService();

    const result = await service.route({
      actor: ACTOR,
      text: "ask risk analyst to review this",
    });

    expect(result).toMatchObject({
      kind: "selected",
      agentId: "risk",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(modelCalls).toEqual([]);
  });

  test("normalizes explicit names with NFKC, case, and whitespace", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("risk", "Ｒｉｓｋ   Analyst")],
    });

    expect(
      await service.route({ actor: ACTOR, text: "Ask  risk\tanalyst  please" }),
    ).toMatchObject({
      kind: "selected",
      agentId: "risk",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(modelCalls).toEqual([]);
  });

  test("does not match a coworker name inside a larger word", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("risk", "Risk")],
    });

    await service.route({ actor: ACTOR, text: "de-risking the portfolio" });

    expect(modelCalls).toHaveLength(1);
  });

  test("uses Unicode token boundaries instead of ASCII word boundaries", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("risk", "Risk")],
    });

    await service.route({ actor: ACTOR, text: "Risk\u{10400} review" });

    expect(modelCalls).toHaveLength(1);
  });

  test("leaves a word two coworkers' names end with to the model", async () => {
    const { service, modelCalls } = makeService({
      roster: [
        profile("risk", "Risk Analyst"),
        profile("data", "Data Analyst"),
      ],
    });

    expect(
      await service.route({ actor: ACTOR, text: "ask analyst to review this" }),
    ).toMatchObject({ kind: "selected", viaMention: false });
    expect(modelCalls).toHaveLength(1);
  });
  test("returns visible choices when two coworkers share the addressed full name", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("a", "Risk Analyst"), profile("b", "Risk Analyst")],
    });

    const result = await service.route({
      actor: ACTOR,
      text: "Risk Analyst, review this",
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("Expected ambiguity");
    expect(result.names).toHaveLength(2);
    expect(modelCalls).toEqual([]);
  });
  test("prefers a unique longer explicit alias over a shared suffix", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("analyst", "Analyst"), profile("risk", "Risk Analyst")],
    });

    expect(
      await service.route({
        actor: ACTOR,
        text: "ask risk analyst to review this",
      }),
    ).toMatchObject({
      kind: "selected",
      agentId: "risk",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(modelCalls).toEqual([]);
  });

  test("returns choices when two independent explicit names appear in long-to-short order", async () => {
    const { service, modelCalls } = makeService();

    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Risk Analyst and Knowledge to review this",
      }),
    ).toEqual({
      kind: "ambiguous",
      names: ["Knowledge", "Risk Analyst"],
    });
    expect(modelCalls).toEqual([]);
  });

  test("returns choices when two independent explicit names appear in short-to-long order", async () => {
    const { service, modelCalls } = makeService();

    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Knowledge and Risk Analyst to review this",
      }),
    ).toEqual({
      kind: "ambiguous",
      names: ["Knowledge", "Risk Analyst"],
    });
    expect(modelCalls).toEqual([]);
  });

  test("selects a profile when all explicit mentions refer to that same profile", async () => {
    const { service, modelCalls } = makeService();

    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Risk Analyst and Risk Analyst to review this",
      }),
    ).toMatchObject({
      kind: "selected",
      agentId: "risk",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(modelCalls).toEqual([]);
  });

  test("keeps partially overlapping full names as independent explicit choices", async () => {
    const { service, modelCalls } = makeService({
      roster: [profile("ann", "Ann Marie"), profile("curie", "Marie Curie")],
    });

    expect(
      await service.route({ actor: ACTOR, text: "ask Ann Marie Curie" }),
    ).toEqual({
      kind: "ambiguous",
      names: ["Ann Marie", "Marie Curie"],
    });
    expect(modelCalls).toEqual([]);
  });

  test("suppresses contained prefix aliases but retains a partially overlapping suffix name", async () => {
    const { service, modelCalls } = makeService({
      roster: [
        profile("ann", "Ann"),
        profile("ann-marie", "Ann Marie"),
        profile("curie", "Marie Curie"),
      ],
    });

    expect(
      await service.route({ actor: ACTOR, text: "ask Ann Marie Curie" }),
    ).toEqual({
      kind: "ambiguous",
      names: ["Ann Marie", "Marie Curie"],
    });
    expect(modelCalls).toEqual([]);
  });

  test("handles many repeated explicit mentions without changing their selection", async () => {
    const { service, modelCalls } = makeService();
    const text = Array.from({ length: 500 }, () => "Risk Analyst").join(
      " and ",
    );

    expect(await service.route({ actor: ACTOR, text })).toMatchObject({
      kind: "selected",
      agentId: "risk",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(modelCalls).toEqual([]);
  });

  test("labels duplicate normalized names distinctly and resolves a chosen label", async () => {
    const { service, modelCalls } = makeService({
      roster: [
        profile("risk-id", "Risk Analyst"),
        profile("risk-copy", "Ｒｉｓｋ   Analyst"),
      ],
    });

    expect(
      await service.route({
        actor: ACTOR,
        text: "ask risk analyst to review this",
      }),
    ).toEqual({
      kind: "ambiguous",
      names: [
        "Risk Analyst (id 7269736b2d636f7079)",
        "Risk Analyst (id 7269736b2d6964)",
      ],
    });
    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Risk Analyst (id 7269736b2d636f7079) to review this",
      }),
    ).toMatchObject({
      kind: "selected",
      agentId: "risk-copy",
      viaMention: false,
      viaNameMatch: true,
    });
    expect(modelCalls).toEqual([]);
  });

  test("uses stable id labels when duplicate ids differ only by case", async () => {
    const roster = [
      profile("risk", "Risk Analyst"),
      profile("Risk", "Risk Analyst"),
    ];
    const { service, modelCalls } = makeService({ roster });

    const result = await service.route({
      actor: ACTOR,
      text: "ask risk analyst to review this",
    });
    expect(result).toEqual({
      kind: "ambiguous",
      names: ["Risk Analyst (id 5269736b)", "Risk Analyst (id 7269736b)"],
    });
    expect(new Set(result.names.map(normalizeCoworkerName)).size).toBe(
      result.names.length,
    );
    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Risk Analyst (id 5269736b) to review this",
      }),
    ).toMatchObject({ kind: "selected", agentId: "Risk" });
    expect(modelCalls).toEqual([]);
  });

  test("uses NFKC-distinct id labels with an order-independent mapping", async () => {
    const optionA = profile("A", "Risk Analyst");
    const optionFullWidthA = profile("Ａ", "Risk Analyst");
    const forward = makeService({ roster: [optionFullWidthA, optionA] });
    const reverse = makeService({ roster: [optionA, optionFullWidthA] });

    const forwardResult = await forward.service.route({
      actor: ACTOR,
      text: "ask risk analyst to review this",
    });
    const reverseResult = await reverse.service.route({
      actor: ACTOR,
      text: "ask risk analyst to review this",
    });

    expect(forwardResult).toEqual({
      kind: "ambiguous",
      names: ["Risk Analyst (id 41)", "Risk Analyst (id efbca1)"],
    });
    expect(reverseResult).toEqual(forwardResult);
    expect(
      await forward.service.route({
        actor: ACTOR,
        text: "ask Risk Analyst (id 41) to review this",
      }),
    ).toMatchObject({ kind: "selected", agentId: "A" });
    expect(
      await forward.service.route({
        actor: ACTOR,
        text: "ask Risk Analyst (id efbca1) to review this",
      }),
    ).toMatchObject({ kind: "selected", agentId: "Ａ" });
  });

  test("keeps a duplicate label bound to its id when new duplicates are added or reordered", async () => {
    const idA = profile("a", "Risk Analyst");
    const idB = profile("b", "Risk Analyst");
    const addedEarlier = profile("A", "Risk Analyst");
    const original = makeService({ roster: [idB, idA] });
    const expanded = makeService({ roster: [idB, addedEarlier, idA] });
    const stableLabel = "Risk Analyst (id 62)";

    expect(
      await original.service.route({
        actor: ACTOR,
        text: "ask risk analyst to review this",
      }),
    ).toEqual({
      kind: "ambiguous",
      names: ["Risk Analyst (id 61)", stableLabel],
    });
    expect(
      await expanded.service.route({
        actor: ACTOR,
        text: "ask risk analyst to review this",
      }),
    ).toEqual({
      kind: "ambiguous",
      names: ["Risk Analyst (id 41)", "Risk Analyst (id 61)", stableLabel],
    });
    expect(
      await expanded.service.route({
        actor: ACTOR,
        text: `ask ${stableLabel}`,
      }),
    ).toMatchObject({ kind: "selected", agentId: "b" });
  });

  test("uses normalization-safe labels for base64url case collisions", async () => {
    const first = profile("\u0800", "Risk Analyst");
    const second = profile("\u081A", "Risk Analyst");
    const { service } = makeService({ roster: [second, first] });

    const result = await service.route({
      actor: ACTOR,
      text: "ask risk analyst to review this",
    });

    expect(result).toEqual({
      kind: "ambiguous",
      names: ["Risk Analyst (id e0a080)", "Risk Analyst (id e0a09a)"],
    });
    expect(new Set(result.names.map(normalizeCoworkerName)).size).toBe(
      result.names.length,
    );
    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Risk Analyst (id e0a080) to review this",
      }),
    ).toMatchObject({ kind: "selected", agentId: "\u0800" });
    expect(
      await service.route({
        actor: ACTOR,
        text: "ask Risk Analyst (id e0a09a) to review this",
      }),
    ).toMatchObject({ kind: "selected", agentId: "\u081A" });
  });

  test("returns none for an absent or empty visible roster", async () => {
    const { service } = makeService({ roster: [] });

    expect(await service.route({ actor: ACTOR, text: "anything" })).toEqual({
      kind: "none",
    });
  });

  test("returns none when an explicit composer id is inaccessible", async () => {
    const { service, modelCalls } = makeService({
      roster: [
        profile("risk", "Risk Analyst"),
        profile("private", "Private Analyst", "private", "u2"),
      ],
    });

    expect(
      await service.route({
        actor: ACTOR,
        text: "anything",
        agentId: "private",
      }),
    ).toEqual({ kind: "none" });
    expect(modelCalls).toEqual([]);
  });

  test("falls back to intent routing when no explicit name appears", async () => {
    const { service, modelCalls } = makeService();

    expect(
      await service.route({ actor: ACTOR, text: "what is our PTO policy" }),
    ).toMatchObject({
      kind: "selected",
      agentId: "knowledge",
      viaMention: false,
    });
    expect(modelCalls).toHaveLength(1);
  });

  test("routes on purpose alone when coworker reachability cannot be loaded", async () => {
    const { service, modelCalls } = makeService({
      reachableSystems: async () => {
        throw new Error("private reachability detail");
      },
    });

    expect(
      await service.route({ actor: ACTOR, text: "help me" }),
    ).toMatchObject({ kind: "selected", agentId: "knowledge" });
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]?.candidates.map((c) => c.reaches)).toEqual([[], []]);
  });
  test("passes only the actor-visible roster to intent routing", async () => {
    const visible = profile("mine", "My Private", "private", ACTOR.id);
    const inaccessible = profile("other", "Other Private", "private", "u2");
    const deleted = {
      ...profile("deleted", "Deleted", "public"),
      deletedAt: new Date(),
    };
    const { service, modelCalls } = makeService({
      roster: [profile("public", "Public"), visible, inaccessible, deleted],
    });

    await service.route({ actor: ACTOR, text: "anything" });

    expect(modelCalls[0]?.candidates.map(({ id }) => id)).toEqual([
      "public",
      "mine",
    ]);
  });

  test("writes selected audit fields exactly once without message text", async () => {
    const { service, audits } = makeService();

    await service.route({ actor: ACTOR, text: "private payroll details" });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetId: "knowledge" });
    expect(audits[0]?.payload).toEqual({
      chosen: "knowledge",
      reason: "intent match",
      fallback: false,
      viaMention: false,
      viaNameMatch: false,
      candidates: ["risk", "knowledge"],
      undecided: null,
    });
    expect(JSON.stringify(audits[0])).not.toContain("private payroll details");
  });

  test("preserves a model fallback audit cause", async () => {
    const { service, audits } = makeService({
      decision: {
        agentId: "knowledge",
        reason: "sent to your default while the router was unreachable",
        fallback: true,
        undecided: "unreachable",
      },
    });

    await service.route({ actor: ACTOR, text: "anything" });

    expect(audits[0]?.payload).toMatchObject({
      fallback: true,
      undecided: "unreachable",
    });
  });

  test("does not persist a model reason that echoes the message", async () => {
    const text = "private payroll details for Sam";
    const { service, audits } = makeService({
      decision: {
        agentId: "knowledge",
        reason: text,
        fallback: false,
        undecided: null,
      },
    });

    const result = await service.route({ actor: ACTOR, text });

    expect(result).toMatchObject({ kind: "selected", reason: text });
    expect(audits[0]?.payload.reason).toBe("intent match");
    expect(JSON.stringify(audits[0])).not.toContain(text);
  });
  test("does not route on words in the shipped coworker names, or on a name mentioned in passing", async () => {
    const roster = [
      profile("general", "General Assistant"),
      profile("knowledge", "Knowledge"),
      profile("risk", "Risk Analyst"),
      profile("expense", "Expense Review"),
      profile("vendor", "Vendor Review"),
      profile("interview", "Interview Notes"),
      profile("release", "Release Notes"),
      profile("followups", "Meeting Follow-ups"),
    ];
    for (const text of [
      "Please review this contract for compliance risks",
      "Summarize my meeting notes",
      "I need an assistant to book travel",
      "What does our knowledge base say about refunds?",
      "Don't send this to Risk Analyst, it's about expenses",
    ]) {
      const { service, modelCalls } = makeService({ roster });
      const result = await service.route({ actor: ACTOR, text });
      expect({ text, kind: result.kind }).toEqual({ text, kind: "selected" });
      expect({ text, model: modelCalls.length }).toEqual({ text, model: 1 });
    }
  });

  test("routes a message that addresses a shipped coworker by its full name", async () => {
    const roster = [
      profile("risk", "Risk Analyst"),
      profile("expense", "Expense Review"),
      profile("knowledge", "Knowledge"),
      profile("followups", "Meeting Follow-ups"),
    ];
    for (const [text, agentId] of [
      ["Risk Analyst, please check this vendor", "risk"],
      ["hey Expense Review: is this claim within policy?", "expense"],
      ["Hi @Knowledge what is our refund policy", "knowledge"],
      ["can you ask Meeting Follow-ups to pull the actions", "followups"],
      ["send this to @Risk Analyst please", "risk"],
      ["Knowledge", "knowledge"],
    ] as const) {
      const { service, modelCalls } = makeService({ roster });
      expect(await service.route({ actor: ACTOR, text })).toMatchObject({
        kind: "selected",
        agentId,
        viaNameMatch: true,
      });
      expect({ text, model: modelCalls.length }).toEqual({ text, model: 0 });
    }
  });
});
