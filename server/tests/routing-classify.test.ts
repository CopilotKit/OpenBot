import { describe, expect, test } from "bun:test";
import {
  createIntentRouter,
  type RoutingCandidate,
  routingPrompt,
} from "../src/routing/classify";

const ROSTER: RoutingCandidate[] = [
  {
    id: "general-assistant",
    name: "General Assistant",
    roleDescription: "everyday work",
  },
  {
    id: "knowledge",
    name: "Knowledge",
    roleDescription: "company knowledge questions",
  },
  {
    id: "risk-analyst",
    name: "Risk Analyst",
    roleDescription: "transaction monitoring and fraud risk",
  },
];
const withAnswer = (answer: string) =>
  createIntentRouter({ complete: async () => answer });
const throwing = () =>
  createIntentRouter({
    complete: async () => {
      throw new Error("model down");
    },
  });

describe("routing a message with no @mention", () => {
  test("routes to the specialist the model picks, named, not a fallback", async () => {
    const r = await withAnswer(
      '{"agentId":"risk-analyst","reason":"fraud review","confidence":0.9}',
    ).route(
      "review this transaction for fraud risk",
      ROSTER,
      "general-assistant",
    );
    expect(r.agentId).toBe("risk-analyst");
    expect(r.name).toBe("Risk Analyst");
    expect(r.fallback).toBe(false);
    expect(r.reason).toContain("fraud");
  });

  test("falls back to the default, named, when the model is unreachable", async () => {
    const r = await throwing().route("anything", ROSTER, "general-assistant");
    expect(r.agentId).toBe("general-assistant");
    expect(r.fallback).toBe(true);
    expect(r.reason).toContain("unreachable");
  });

  test("falls back when the answer does not parse", async () => {
    const r = await withAnswer("I think the risk analyst?").route(
      "x",
      ROSTER,
      "general-assistant",
    );
    expect(r.agentId).toBe("general-assistant");
    expect(r.fallback).toBe(true);
  });

  test("NEVER acts on an id that is not on the roster", async () => {
    const r = await withAnswer(
      '{"agentId":"payroll-bot","reason":"payroll","confidence":0.99}',
    ).route("x", ROSTER, "general-assistant");
    expect(r.agentId).toBe("general-assistant");
    expect(r.fallback).toBe(true);
    expect(r.reason).toContain("no coworker on your roster");
  });

  test("defers to the default when confidence is low", async () => {
    const r = await withAnswer(
      '{"agentId":"risk-analyst","reason":"maybe","confidence":0.3}',
    ).route("hi", ROSTER, "general-assistant");
    expect(r.agentId).toBe("general-assistant");
    expect(r.fallback).toBe(true);
  });

  test("a fenced/padded JSON answer is still parsed", async () => {
    const r = await withAnswer(
      '```json\n{"agentId":"knowledge","reason":"policy lookup","confidence":0.8}\n```',
    ).route("what is our refund policy", ROSTER, "general-assistant");
    expect(r.agentId).toBe("knowledge");
    expect(r.fallback).toBe(false);
  });

  test("a single-coworker roster is a fallback, not a model call", async () => {
    let called = false;
    const r = await createIntentRouter({
      complete: async () => {
        called = true;
        return "{}";
      },
    }).route("x", [ROSTER[0]!], "general-assistant");
    expect(called).toBe(false);
    expect(r.agentId).toBe("general-assistant");
    expect(r.fallback).toBe(true);
  });
});

/**
 * The router is told what each coworker can reach, not only what it is for.
 *
 * Routing on the role description alone routes on what somebody wrote a coworker was for, which is
 * not the same as what it can do. A question about a document in Google Drive went to the coworker
 * whose description says "company knowledge" and which held no Drive grants at all. It browsed to
 * the vendor, met a sign-in wall, and asked the person to sign in to an account they had already
 * connected. The coworker that could have answered was one line further down the roster.
 */
describe("routing on what a coworker can reach", () => {
  const withReach: RoutingCandidate[] = [
    {
      id: "knowledge",
      name: "Knowledge",
      roleDescription: "company knowledge questions",
    },
    {
      id: "risk-analyst",
      name: "Risk Analyst",
      roleDescription: "risk and compliance",
      reaches: ["google-drive"],
    },
  ];

  test("names the systems in the roster the model is given", () => {
    const prompt = routingPrompt("what is in my Drive doc?", withReach);
    expect(prompt).toContain("can reach: google-drive");
  });

  test("says nothing about reach for a coworker that holds nothing", () => {
    // Most coworkers in most deployments. An empty line here would be noise in every prompt.
    const prompt = routingPrompt("anything", withReach);
    const knowledgeBlock = prompt.slice(
      prompt.indexOf("id: knowledge"),
      prompt.indexOf("id: risk-analyst"),
    );
    expect(knowledgeBlock).not.toContain("can reach");
  });

  test("tells the model to prefer reach without letting it override purpose", () => {
    /*
     * Both halves matter. Preferring a coworker that can reach the system is the fix; letting that
     * outrank purpose would send every question to whichever coworker happens to hold a connector,
     * which is a different bug with the same shape.
     */
    const prompt = routingPrompt("anything", withReach);
    expect(prompt).toContain("prefer that coworker");
    expect(prompt).toContain("Purpose still comes first");
  });

  test("a roster with no reach at all reads exactly as it did before", () => {
    // A deployment with no connectors must not have its routing prompt changed by this.
    const plain = routingPrompt("anything", [
      { id: "a", name: "A", roleDescription: "alpha" },
    ]);
    expect(plain).not.toContain("can reach");
  });
});

/**
 * A fallback that lands on a coworker who cannot answer.
 *
 * Every path into the fallback is "we are not sure", and the default is a guess. When the message
 * names a system exactly one coworker can reach, it is not a guess: the others cannot answer it at
 * all, and a Bot without the connector browses to the vendor and meets a sign-in wall the connector
 * exists to avoid.
 *
 * Found by driving it. The router's model call was throwing on every request, so every decision took
 * the unreachable path, and a question naming Google Drive went to a Bot holding no Drive tools. The
 * broken call is fixed separately; this is the part that was wrong even when it worked.
 */
describe("falling back to somebody who can actually answer", () => {
  const ROSTER: RoutingCandidate[] = [
    {
      id: "general-assistant",
      name: "General Assistant",
      roleDescription: "everyday work",
    },
    {
      id: "risk-analyst",
      name: "Risk Analyst",
      roleDescription: "risk and compliance",
      reaches: ["google-drive"],
    },
  ];

  const BROKEN = createIntentRouter({
    complete: async () => {
      throw new Error("router unreachable");
    },
  });

  test("names the one coworker that can reach the system in the message", async () => {
    const decision = await BROKEN.route(
      "In my OpenBot PRD in Google Drive, list the proxy metrics.",
      ROSTER,
      "general-assistant",
    );

    expect(decision.agentId).toBe("risk-analyst");
    expect(decision.reason).toContain("google-drive");
    // Still a fallback: nothing inferred the fit, the roster just answered it.
    expect(decision.fallback).toBe(true);
  });

  test("matches the vendor as somebody would write it", async () => {
    // `google-drive` is an id. Nobody types a hyphen.
    const decision = await BROKEN.route(
      "search google drive for the PRD",
      ROSTER,
      "general-assistant",
    );

    expect(decision.agentId).toBe("risk-analyst");
  });

  test("uses the default when the message names no system", async () => {
    const decision = await BROKEN.route(
      "what is 8 plus 5",
      ROSTER,
      "general-assistant",
    );

    expect(decision.agentId).toBe("general-assistant");
  });

  test("uses the default when two coworkers reach the same system", async () => {
    // Not a decision this can make. Two holders is exactly the case the router is for.
    const shared: RoutingCandidate[] = [
      { ...ROSTER[0], reaches: ["google-drive"] } as RoutingCandidate,
      ROSTER[1] as RoutingCandidate,
    ];

    const decision = await BROKEN.route(
      "look in google drive",
      shared,
      "general-assistant",
    );

    expect(decision.agentId).toBe("general-assistant");
  });

  test("a confident match still wins over reach", async () => {
    /*
     * The line this must not cross. A specialist with no connectors is the right answer to a
     * question about its specialism, and reach is a hint for the router rather than a filter over
     * it. This only decides where a guess would otherwise have.
     */
    const confident = createIntentRouter({
      complete: async () =>
        JSON.stringify({
          agentId: "general-assistant",
          reason: "everyday work",
          confidence: 0.9,
        }),
    });

    const decision = await confident.route(
      "tidy up my google drive notes",
      ROSTER,
      "risk-analyst",
    );

    expect(decision.agentId).toBe("general-assistant");
    expect(decision.fallback).toBe(false);
  });
});
