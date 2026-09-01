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

  /*
   * A system id buried inside a longer word does not name the system.
   *
   * `includes("slack")` is true of "slacker" and `includes("jira")` is true of "jirafa" — the
   * Spanish for giraffe — so a message that names neither system was read as naming one and, in a
   * fallback, pinned the whole conversation to that specialist. The id has to sit on its own.
   */
  const NAMED: RoutingCandidate[] = [
    { id: "general", name: "General", roleDescription: "everyday work" },
    {
      id: "slackbot",
      name: "Slack",
      roleDescription: "chat",
      reaches: ["slack"],
    },
    {
      id: "jirabot",
      name: "Jira",
      roleDescription: "tickets",
      reaches: ["jira"],
    },
  ];

  test("a system id inside an unrelated word is not a match", async () => {
    const slacker = await BROKEN.route(
      "how do I deal with a slacker on my team",
      NAMED,
      "general",
    );
    expect(slacker.agentId).toBe("general");

    const giraffe = await BROKEN.route(
      "escribe un cuento sobre una jirafa",
      NAMED,
      "general",
    );
    expect(giraffe.agentId).toBe("general");
  });

  test("the same system named on its own still routes to its holder", async () => {
    const decision = await BROKEN.route(
      "post this update to slack for me",
      NAMED,
      "general",
    );
    expect(decision.agentId).toBe("slackbot");
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

/**
 * Why a message was not routed, as a thing a deployment can count.
 *
 * `fallback` says an inferred match did not happen. It does not say whether the router declined or
 * the router failed, and only one of those is a deployment with something wrong with it. #178 was
 * exactly that: the router 404'd on every deployment that set `OPENAI_BASE_URL`, and its changelog
 * says untagged messages "silently stopped being routed and nothing said why". These pin the field
 * that answers it.
 */
describe("saying why a message was not routed", () => {
  test("a confident match leaves nothing undecided", async () => {
    const decision = await withAnswer(
      JSON.stringify({
        agentId: "risk-analyst",
        reason: "fraud",
        confidence: 0.9,
      }),
    ).route("is this transaction fraud", ROSTER, "general-assistant");

    expect(decision.fallback).toBe(false);
    expect(decision.undecided).toBeNull();
  });

  test("an unreachable router is named as unreachable", async () => {
    const decision = await throwing().route(
      "anything",
      ROSTER,
      "general-assistant",
    );
    expect(decision.undecided).toBe("unreachable");
  });

  test("an answer that does not parse is named as unparsed", async () => {
    const decision = await withAnswer('{ "agentId": }').route(
      "anything",
      ROSTER,
      "general-assistant",
    );
    expect(decision.undecided).toBe("unparsed");
  });

  test("prose with no JSON in it is unparsed, not off-roster", async () => {
    /*
     * A model answering in sentences is a model not following the format. Recorded as off-roster it
     * reads as a roster problem, and whoever investigates goes and looks at their roster.
     */
    const decision = await withAnswer("I think Risk Analyst is best.").route(
      "anything",
      ROSTER,
      "general-assistant",
    );
    expect(decision.undecided).toBe("unparsed");
  });

  test("an id that is not on the roster is named as off-roster", async () => {
    const decision = await withAnswer(
      JSON.stringify({ agentId: "somebody-else", confidence: 0.9 }),
    ).route("anything", ROSTER, "general-assistant");
    expect(decision.undecided).toBe("off-roster");
  });

  test("an honest low confidence is named as unconfident, not as a failure", async () => {
    // The one cause that is the feature working. Counting it with the failures would make the
    // number useless, which is the whole reason this is a named cause rather than a boolean.
    const decision = await withAnswer(
      JSON.stringify({ agentId: "risk-analyst", confidence: 0.2 }),
    ).route("anything", ROSTER, "general-assistant");
    expect(decision.undecided).toBe("unconfident");
  });

  test("a roster of one is named as one-candidate, and asks nothing", async () => {
    const decision = await throwing().route(
      "anything",
      [ROSTER[0] as RoutingCandidate],
      "general-assistant",
    );
    expect(decision.undecided).toBe("one-candidate");
  });

  test("the reach answer does not hide that the router never answered", async () => {
    /*
     * THE CASE THIS EXISTS FOR. Landing on the only coworker that can reach Google Drive is a good
     * outcome, and it says nothing about whether the router was up. Before this the reach sentence
     * replaced the failure entirely, so a deployment whose router had been down for a week produced
     * rows that read exactly like reach-based routing working as intended.
     */
    const reaching: RoutingCandidate[] = [
      { ...(ROSTER[0] as RoutingCandidate) },
      {
        ...(ROSTER[1] as RoutingCandidate),
        reaches: ["google-drive"],
      },
    ];

    const decision = await throwing().route(
      "find the PRD in google drive",
      reaching,
      "general-assistant",
    );

    // Still routed by reach, and still a fallback — both unchanged.
    expect(decision.agentId).toBe("knowledge");
    expect(decision.reason).toContain("google-drive");
    expect(decision.fallback).toBe(true);
    // And the router failure survives it.
    expect(decision.undecided).toBe("unreachable");
  });

  test("reach after a low-confidence answer says unconfident, not unreachable", async () => {
    // The two are told apart on the reach path as well, or the count is wrong wherever reach fires.
    const reaching: RoutingCandidate[] = [
      { ...(ROSTER[0] as RoutingCandidate) },
      {
        ...(ROSTER[1] as RoutingCandidate),
        reaches: ["google-drive"],
      },
    ];

    const decision = await withAnswer(
      JSON.stringify({ agentId: "knowledge", confidence: 0.1 }),
    ).route("find the PRD in google drive", reaching, "general-assistant");

    expect(decision.agentId).toBe("knowledge");
    expect(decision.undecided).toBe("unconfident");
  });
});
