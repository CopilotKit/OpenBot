import { describe, expect, test } from "bun:test";
import {
  createCoordinationTools,
  handoffTool,
} from "../src/agents/handoff-tool";
import {
  decideAction,
  effectiveHostCommandPolicy,
  globMatches,
  reviewAction,
  safetyRequirement,
} from "../src/approvals/policy";
import {
  createApprovalService,
  HANDLED_BY_PERSON,
} from "../src/approvals/service";
import {
  type ApprovalAction,
  type ApprovalCandidate,
  type ApprovalPolicyOutcome,
  type ApprovalPreferences,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalRule,
  type ApprovalStore,
  type ApprovalTeamRule,
  type ApprovalTeamSettings,
  withApprovalContext,
} from "../src/approvals/types";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createHostAccessBroker } from "../src/host-access/broker";
import { createPrivateShareCheck } from "../src/proactive/private-share";

const candidate = (
  over: Partial<ApprovalCandidate> = {},
): ApprovalCandidate => ({
  actorId: "owner",
  botId: "bot",
  toolRef: "mcp/gmail/send_email",
  effect: "write",
  scope: "gmail",
  args: { to: "sam@example.com", subject: "Notes" },
  ...over,
});
const rule = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalRule> = {},
): ApprovalRule => ({
  id: `rule-${behaviour}`,
  ownerUserId: "owner",
  botId: "*",
  toolRef: "mcp/gmail/*",
  effect: "*",
  scope: "*",
  behaviour,
  revokedAt: null,
  createdAt: new Date(),
  ...over,
});
const team = (
  behaviour: ApprovalRule["behaviour"],
  over: Partial<ApprovalTeamRule> = {},
): ApprovalTeamRule => {
  const { ownerUserId: _owner, ...rest } = rule(
    behaviour,
    over as ApprovalRule,
  );
  return { ...rest, id: `team-${behaviour}`, createdBy: "admin", ...over };
};
const base = {
  team: [] as ApprovalTeamRule[],
  personal: [] as ApprovalRule[],
  customRulesEnabled: true,
  autoReview: false,
  askBeforeChanges: false,
};
const said = (content: string) => [
  { id: "u1", role: "user" as const, content },
];
const model =
  (answer: object | string | Error, calls: string[] = []) =>
  async (prompt: string) => {
    calls.push(prompt);
    if (answer instanceof Error) throw answer;
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };

describe("custom rules", () => {
  test("globs match whole values and only treat * as a wildcard", () => {
    expect(globMatches("mcp/gmail/*", "mcp/gmail/send_email")).toBeTrue();
    expect(globMatches("mcp/gmail/*", "mcp/gmailx")).toBeFalse();
    expect(globMatches("a.b", "aXb")).toBeFalse();
    expect(globMatches("*", "anything")).toBeTrue();
  });

  test("the four behaviours", async () => {
    const decide = (behaviour: ApprovalRule["behaviour"], extra = {}) =>
      decideAction({
        ...base,
        candidate: candidate(),
        personal: [rule(behaviour)],
        ...extra,
      });
    expect((await decide("allow")).behaviour).toBe("allow");
    expect((await decide("ask")).behaviour).toBe("ask");
    expect((await decide("hand_off")).behaviour).toBe("hand_off");
    // Pre-approved without a reviewer cannot be established, so it asks.
    expect((await decide("pre_approved")).behaviour).toBe("ask");
    expect(
      (
        await decide("pre_approved", {
          messages: said("Email Sam the notes."),
          model: model({
            verdict: "proceed",
            preApproved: true,
            reason: "Asked for.",
          }),
        })
      ).behaviour,
    ).toBe("allow");
    expect(
      (
        await decide("pre_approved", {
          messages: said("Summarise my inbox."),
          model: model({
            verdict: "proceed",
            preApproved: false,
            reason: "Not asked for.",
          }),
        })
      ).behaviour,
    ).toBe("ask");
  });

  test("ask first beats allow automatically, across layers, and team rules are counted", async () => {
    const outcome = await decideAction({
      ...base,
      candidate: candidate(),
      personal: [rule("allow"), rule("ask", { id: "ask-first" })],
    });
    expect(outcome).toMatchObject({ behaviour: "ask", ruleId: "ask-first" });
    const locked = await decideAction({
      ...base,
      candidate: candidate(),
      team: [team("ask")],
      personal: [rule("allow")],
    });
    expect(locked).toMatchObject({ behaviour: "ask", source: "team_rule" });
  });

  test("switching custom rules off keeps team rules and drops personal ones", async () => {
    const outcome = await decideAction({
      ...base,
      candidate: candidate(),
      customRulesEnabled: false,
      team: [team("allow")],
      personal: [rule("hand_off")],
    });
    expect(outcome).toMatchObject({ behaviour: "allow", source: "team_rule" });
  });

  test("with no rule the person's ask-before-changes default applies to changes only", async () => {
    expect(
      (
        await decideAction({
          ...base,
          candidate: candidate(),
          askBeforeChanges: true,
        })
      ).behaviour,
    ).toBe("ask");
    expect(
      (
        await decideAction({
          ...base,
          candidate: candidate({ effect: "read" }),
          askBeforeChanges: true,
        })
      ).behaviour,
    ).toBe("allow");
  });
});

describe("built-in safety requirements", () => {
  test("credentials, security settings and payments always go to the person, whatever the rules say", async () => {
    for (const [args, id] of [
      [{ ref: "e3", text: "hunter2", field: "New password" }, "credentials"],
      [{ url: "https://github.com/settings/security" }, "security_settings"],
      [
        { button: "Place order", url: "https://shop.example/checkout" },
        "payments",
      ],
    ] as const) {
      const action = candidate({ toolRef: "computer_type", args });
      expect(safetyRequirement(action)?.id).toBe(id);
      const outcome = await decideAction({
        ...base,
        candidate: action,
        team: [team("allow", { toolRef: "*" })],
        personal: [rule("allow", { toolRef: "*" })],
      });
      expect(outcome).toMatchObject({
        behaviour: "hand_off",
        source: "safety",
      });
    }
    // The Bot's own workspace is not an account.
    expect(
      safetyRequirement(
        candidate({
          toolRef: "computer_write_file",
          args: { path: "config.env", contents: "DB_PASSWORD=" },
        }),
      ),
    ).toBeUndefined();
    // Reading a checkout page is not paying.
    expect(
      safetyRequirement(
        candidate({
          toolRef: "computer_navigate",
          effect: "read",
          args: { url: "https://shop.example/checkout" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("the reviewer's safety classification", () => {
  const decide = (
    answer: object | Error,
    over: Partial<ApprovalCandidate> = {},
  ) =>
    decideAction({
      ...base,
      candidate: candidate({
        toolRef: "mcp/bank/submit_form",
        args: { form: "f1" },
        ...over,
      }),
      autoReview: true,
      personal: [rule("allow", { toolRef: "*" })],
      model: model(answer),
    });

  test("adds a hand-off the keywords missed, even over an allow rule", async () => {
    expect(
      await decide({
        verdict: "proceed",
        preApproved: true,
        safety: "payments",
        reason: "This submits a transfer.",
      }),
    ).toMatchObject({ behaviour: "hand_off", source: "safety" });
  });

  test("cannot remove the keyword floor", async () => {
    const outcome = await decide(
      {
        verdict: "proceed",
        preApproved: true,
        safety: "none",
        reason: "Fine.",
      },
      { toolRef: "computer_type", args: { field: "New password", text: "x" } },
    );
    expect(outcome).toMatchObject({ behaviour: "hand_off", source: "safety" });
  });

  test("an unreachable reviewer leaves the keyword result, and asks", async () => {
    expect(await decide(new Error("down"))).toMatchObject({
      behaviour: "ask",
      source: "auto_review",
    });
  });

  test("a reviewer hand-off outranks an ask rule", async () => {
    const outcome = await decideAction({
      ...base,
      candidate: candidate(),
      autoReview: true,
      personal: [rule("ask")],
      model: model({
        verdict: "hand_off",
        preApproved: false,
        reason: "Legal.",
      }),
    });
    expect(outcome.behaviour).toBe("hand_off");
  });
});

describe("auto-review", () => {
  test("its verdicts stop an allow rule, and it fails closed", async () => {
    const run = (answer: object | string | Error) =>
      decideAction({
        ...base,
        candidate: candidate(),
        autoReview: true,
        personal: [rule("allow")],
        messages: said("Tidy my inbox."),
        model: model(answer),
      });
    expect(
      (await run({ verdict: "proceed", preApproved: false, reason: "Fine." }))
        .behaviour,
    ).toBe("allow");
    expect(
      await run({
        verdict: "needs_approval",
        preApproved: false,
        reason: "Emails someone new.",
      }),
    ).toMatchObject({ behaviour: "ask", source: "auto_review" });
    expect(
      (await run({ verdict: "hand_off", preApproved: false, reason: "Legal." }))
        .behaviour,
    ).toBe("hand_off");
    const failed = await run(new Error("timeout"));
    expect(failed).toMatchObject({
      behaviour: "ask",
      source: "auto_review",
      review: { failedClosed: true },
    });
    expect((await run("not json")).behaviour).toBe("ask");
    expect(
      (await run({ verdict: "yes please", preApproved: true, reason: "x" }))
        .behaviour,
    ).toBe("ask");
  });

  test("an unreachable reviewer times out closed", async () => {
    const verdict = await reviewAction({
      model: (_prompt, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        ),
      candidate: candidate(),
      request: "",
      timeoutMs: 20,
    });
    expect(verdict).toMatchObject({
      verdict: "needs_approval",
      failedClosed: true,
    });
  });

  test("memory writes, settings changes and reads are not reviewed", async () => {
    const calls: string[] = [];
    for (const action of [
      candidate({ toolRef: "memory/remember" }),
      candidate({ toolRef: "bot/update_settings" }),
      candidate({ effect: "read" }),
    ])
      expect(
        (
          await decideAction({
            ...base,
            candidate: action,
            autoReview: true,
            model: model(
              { verdict: "hand_off", preApproved: false, reason: "x" },
              calls,
            ),
          })
        ).behaviour,
      ).toBe("allow");
    expect(calls).toEqual([]);
  });

  test("a vendor tool named for settings is still reviewed", async () => {
    const calls: string[] = [];
    const decided = await decideAction({
      ...base,
      candidate: candidate({
        toolRef: "composio/GITHUB_UPDATE_REPOSITORY_SETTINGS",
        scope: "github",
        args: { repo: "openbot", private: false },
      }),
      autoReview: true,
      model: model(
        {
          verdict: "needs_approval",
          preApproved: false,
          reason: "makes the repository public",
        },
        calls,
      ),
    });
    expect(calls).toHaveLength(1);
    expect(decided.behaviour).not.toBe("allow");
  });

  test("the reviewer sees the person's request and the action, as data", async () => {
    const calls: string[] = [];
    await decideAction({
      ...base,
      candidate: candidate(),
      autoReview: true,
      messages: said("Send Sam my notes"),
      model: model(
        { verdict: "proceed", preApproved: true, reason: "ok" },
        calls,
      ),
    });
    expect(calls[0]).toContain("<request>\nSend Sam my notes\n</request>");
    expect(calls[0]).toContain('"tool": "mcp/gmail/send_email"');
  });
});

test("host command policy: the stricter of member and team cap applies", () => {
  expect(effectiveHostCommandPolicy("allow", "ask")).toBe("ask");
  expect(effectiveHostCommandPolicy("ask", "allow")).toBe("ask");
  expect(effectiveHostCommandPolicy("allow", "allow")).toBe("allow");
  expect(effectiveHostCommandPolicy("never", "allow")).toBe("never");
  expect(effectiveHostCommandPolicy("ask", "never")).toBe("never");
});

/** An in-memory store with the policy surface, enough to drive the gate end to end. */
function memoryStore(options: {
  preferences?: Partial<ApprovalPreferences>;
  team?: Partial<ApprovalTeamSettings>;
  teamRules?: ApprovalTeamRule[];
  rules?: ApprovalRule[];
}) {
  const requests = new Map<string, ApprovalRecord>();
  const decisions: ApprovalPolicyOutcome[] = [];
  const store: ApprovalStore = {
    enabled: async () => options.preferences?.enabled ?? false,
    setEnabled: async () => undefined,
    open: async (action: ApprovalAction) => {
      const existing = [...requests.values()].find(
        (row) => row.action.toolCallId === action.toolCallId,
      );
      if (existing) return existing;
      const row: ApprovalRecord = {
        id: `request-${requests.size + 1}`,
        ownerUserId: action.actorId,
        action,
        status: "pending",
        decision: null,
        result: null,
        createdAt: new Date(),
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      };
      requests.set(row.id, row);
      return row;
    },
    get: async (_owner, id) => requests.get(id) as ApprovalRecord,
    list: async () => [...requests.values()],
    decide: async (_owner, id, decision) => {
      const row = requests.get(id) as ApprovalRecord;
      const handOff = row.action.policy?.behaviour === "hand_off";
      if (handOff && decision !== "handled" && decision !== "deny")
        throw new ApprovalRefusedError("handed to you");
      Object.assign(row, {
        decision,
        status: decision === "deny" ? "denied" : "approved",
      });
      return row;
    },
    consume: async () => true,
    saveResult: async () => true,
    finish: async () => undefined,
    rules: async () => options.rules ?? [],
    revoke: async () => undefined,
    policy: {
      preferences: async () => ({
        enabled: false,
        autoReview: false,
        hostCommands: "ask",
        ...options.preferences,
      }),
      setPreferences: async () => {
        throw new Error("unused");
      },
      teamSettings: async () => ({
        enforceAutoReview: false,
        customRulesEnabled: true,
        hostCommandsCap: "allow",
        ...options.team,
      }),
      setTeamSettings: async () => {
        throw new Error("unused");
      },
      teamRules: async () => options.teamRules ?? [],
      createRule: async () => {
        throw new Error("unused");
      },
      createTeamRule: async () => {
        throw new Error("unused");
      },
      revokeTeamRule: async () => undefined,
      updateRule: async () => {
        throw new Error("unused");
      },
      updateTeamRule: async () => {
        throw new Error("unused");
      },
      findEquivalent: async ({ threadId, equivalence, excludeToolCallId }) =>
        [...requests.values()]
          .reverse()
          .find(
            (row) =>
              row.action.threadId === threadId &&
              row.action.equivalence === equivalence &&
              row.action.toolCallId !== excludeToolCallId,
          ),
      withdrawPending: async () => [],
      recordDecision: async ({ outcome }) => {
        decisions.push(outcome);
      },
    },
  };
  return { store, requests, decisions };
}

const context = {
  runId: "run",
  threadId: "thread",
  toolCallId: "call-1",
  toolName: "mcp/gmail/send_email",
  args: {},
  messages: said("Tidy my inbox"),
  state: {},
  context: [],
  forwardedProps: {},
  initiator: { kind: "routine" as const, id: "routine-1" },
};

describe("the approval gate", () => {
  test("a team-enforced reviewer that cannot answer suspends the action for approval and audits it", async () => {
    const { store, decisions } = memoryStore({
      team: { enforceAutoReview: true },
      rules: [rule("allow")],
    });
    const service = createApprovalService(store, undefined, undefined, {
      review: model(new Error("model down")),
    });
    const error = await withApprovalContext(context, () =>
      service.gate(candidate()),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HeadlessToolSuspension);
    expect(decisions).toEqual([
      expect.objectContaining({
        behaviour: "ask",
        source: "auto_review",
        review: expect.objectContaining({ failedClosed: true }),
      }),
    ]);
  });

  test("an allowed action proceeds without opening a request, and its verdict is on the trail", async () => {
    const { store, requests, decisions } = memoryStore({
      rules: [rule("allow")],
    });
    const service = createApprovalService(store);
    await expect(
      withApprovalContext(context, () => service.gate(candidate())),
    ).resolves.toBeUndefined();
    expect(requests.size).toBe(0);
    expect(decisions[0]).toMatchObject({
      behaviour: "allow",
      source: "personal_rule",
    });
  });

  test("a hand-off is marked done by the person and is never executed for them", async () => {
    const { store, requests } = memoryStore({});
    const service = createApprovalService(store);
    const paying = candidate({
      toolRef: "computer_click",
      args: { button: "Pay now" },
    });
    const suspended = await withApprovalContext(context, () =>
      service.gate(paying),
    ).catch((failure: unknown) => failure);
    expect(suspended).toBeInstanceOf(HeadlessToolSuspension);
    expect((suspended as HeadlessToolSuspension).message).toContain(
      "This needs you",
    );
    expect((suspended as HeadlessToolSuspension).waiting.handoff).toBeTrue();
    const [request] = [...requests.values()];
    await expect(
      service.decide("owner", request?.id as string, "allow_once"),
    ).rejects.toThrow("handed to you");
    await service.decide("owner", request?.id as string, "handled");
    const permit = await withApprovalContext(context, () =>
      service.gate(paying),
    );
    expect(permit).toMatchObject({ replay: HANDLED_BY_PERSON });
    let executed = false;
    const continued: unknown[] = [];
    await service.resume("owner", request?.id as string, {
      validate: async (action) => action,
      execute: async () => {
        executed = true;
      },
      continue: async (input) => {
        continued.push(input.result);
      },
    });
    expect(executed).toBeFalse();
    expect(continued).toEqual([{ content: HANDLED_BY_PERSON }]);
  });
});

describe("delegation is gated", () => {
  const desk = {
    sent: 0,
    send: async () => {
      desk.sent += 1;
      return { ok: true as const, toName: "Research" };
    },
  };
  const tool = (gate: Parameters<typeof handoffTool>[0]["approvalGate"]) =>
    handoffTool({
      desk: desk as unknown as Parameters<typeof handoffTool>[0]["desk"],
      from: {
        actorId: "owner",
        botId: "bot",
        runId: "run",
        threadId: "thread",
        depth: 0,
      } as never,
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
      approvalGate: gate,
    });

  test("an ask-first rule on delegation suspends the hop before it is sent", async () => {
    const { store } = memoryStore({
      rules: [rule("ask", { toolRef: "bot/message_bot" })],
    });
    const service = createApprovalService(store);
    desk.sent = 0;
    const error = await withApprovalContext(
      context,
      () =>
        tool(service.gate)?.execute({
          bot: "Research",
          task: "Look it up",
        }) as Promise<string>,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HeadlessToolSuspension);
    expect(desk.sent).toBe(0);
  });

  test("an approved hand-off is re-checked, sent once, and its answer continues the conversation", async () => {
    const { createApprovedActionExecutor } = await import(
      "../src/approvals/execute"
    );
    const { store } = memoryStore({
      rules: [rule("ask", { toolRef: "bot/message_bot" })],
    });
    const service = createApprovalService(store);
    desk.sent = 0;
    const coordination = createCoordinationTools({
      desk: desk as never,
      caps: { maxDepth: 2, maxPerRun: 3 } as never,
      approvalGate: service.gate,
      botsReachableFrom: async () => ["research"],
      auditStore: { insert: async () => undefined },
      authoriseRun: async () => true,
      route: async () => ({ reached: "nobody" }),
    } as never);
    const args = { bot: "Research", task: "Look it up" };
    const handoff = { ...context, toolName: "message_bot", args };
    const asked = await withApprovalContext(handoff, () =>
      coordination.call({
        name: "message_bot",
        args,
        run: {
          actorId: "owner",
          botId: "bot",
          runId: "run",
          threadId: "thread",
          depth: 0,
        } as never,
      }),
    ).catch((failure: unknown) => failure);
    expect(asked).toBeInstanceOf(HeadlessToolSuspension);
    expect(desk.sent).toBe(0);
    const [request] = await store.list("owner");
    await service.decide("owner", request?.id as string, "allow_once");
    const execute = createApprovedActionExecutor({
      sourceFor: async () => ({ channelId: "channel" }),
      gate: service.gate,
      computerTools: async () => [],
      hostTools: () => [],
      callTool: async () => {
        throw new Error("a hand-off is not a connector call");
      },
      credentialActorFor: async (actorId) => actorId,
      coordinationCall: (input) => coordination.call(input),
      answer: (result) => result.text,
      privateShareToolRef: "openbot/private_share",
      refusalMarker: "REFUSED:",
      personInitiator: { kind: "person", id: "" },
    });
    const continued: { content: string; error?: string }[] = [];
    await service.resume("owner", request?.id as string, {
      validate: (action) =>
        service.validateReentry(action, () => execute(action)),
      execute,
      continue: async (input) => {
        continued.push(input.result);
      },
    });
    expect(desk.sent).toBe(1);
    expect(continued).toHaveLength(1);
    expect(continued[0]?.error).toBeUndefined();
  });

  test("a refused delegation is a sentence, not a hop", async () => {
    desk.sent = 0;
    const text = await tool(async () => {
      throw new ApprovalRefusedError("You declined this action.");
    })?.execute({ bot: "Research", task: "Look it up" });
    expect(text).toBe("That handoff was not sent: You declined this action.");
    expect(desk.sent).toBe(0);
  });
});

describe("handing work to another person's Bot checks private sharing first", () => {
  const sends: string[] = [];
  const desk = {
    send: async () => {
      sends.push("sent");
      return { ok: true as const, toName: "Priya's Bot" };
    },
  } as unknown as Parameters<typeof handoffTool>[0]["desk"];
  const share = (decision?: "denied") => {
    const { store } = memoryStore({});
    const open = store.open;
    store.open = async (action) => {
      const row = await open(action);
      if (decision) row.status = decision;
      return row;
    };
    return handoffTool({
      desk,
      from: {
        actorId: "owner",
        botId: "bot",
        runId: "run",
        threadId: "thread",
        depth: 0,
      } as never,
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
      privateShare: {
        check: createPrivateShareCheck({ approvals: store }),
        audienceFor: async (_from, target) =>
          target === "Priya's Bot"
            ? {
                kind: "handoff",
                id: "priya",
                recipientUserIds: ["priya"],
                label: target,
              }
            : null,
      },
    });
  };
  const person = { ...context, initiator: { kind: "person" as const } };

  test("a headless turn waits durably and nothing is sent", async () => {
    sends.length = 0;
    const error = await withApprovalContext(
      context,
      () =>
        share()?.execute({
          bot: "Priya's Bot",
          task: "Review my notes",
        }) as Promise<string>,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HeadlessToolSuspension);
    expect(sends).toEqual([]);
  });

  test("a person's own turn tells the model to wait, and a no is not sent", async () => {
    sends.length = 0;
    const waiting = await withApprovalContext(
      person,
      () =>
        share()?.execute({
          bot: "Priya's Bot",
          task: "Review my notes",
        }) as Promise<string>,
    );
    expect(waiting).toContain("waiting for their permission");
    const declined = await withApprovalContext(
      person,
      () =>
        share("denied")?.execute({
          bot: "Priya's Bot",
          task: "Review",
        }) as Promise<string>,
    );
    expect(declined).toContain("You declined sharing this");
    expect(sends).toEqual([]);
  });

  test("the owner's own Bot is not a share", async () => {
    sends.length = 0;
    await withApprovalContext(
      person,
      () =>
        share()?.execute({
          bot: "My Researcher",
          task: "Look it up",
        }) as Promise<string>,
    );
    expect(sends).toEqual(["sent"]);
  });
});

describe("a question that would reach somebody besides the owner checks private sharing first", () => {
  const asked: string[] = [];
  const tools = (reach: "group" | "owner") => {
    const { store } = memoryStore({});
    return createCoordinationTools({
      desk: {} as never,
      caps: { maxDepth: 0, maxPerRun: 0 } as never,
      botsReachableFrom: async () => [],
      auditStore: { insert: async () => undefined },
      authoriseRun: async () => true,
      route: async (question) => {
        asked.push(question.question);
        return { reached: "the person in this conversation" };
      },
      privateShare: {
        check: createPrivateShareCheck({ approvals: store }),
        audienceFor: async () => null,
        questionAudience: async () =>
          reach === "group"
            ? {
                audience: {
                  kind: "group",
                  id: "g1",
                  recipientUserIds: ["owner", "priya"],
                  label: "Launch group",
                },
                origin: { kind: "private_conversation" },
              }
            : null,
      },
    });
  };
  const run = {
    actorId: "owner",
    botId: "bot",
    runId: "run",
    threadId: "thread",
    depth: 0,
  } as never;

  test("a group question from a headless turn waits and is not asked", async () => {
    asked.length = 0;
    const [ask] = await tools("group").toolsForRun(run);
    const error = await withApprovalContext(
      context,
      () => ask?.execute({ question: "Which budget?" }) as Promise<string>,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HeadlessToolSuspension);
    expect(asked).toEqual([]);
  });

  test("a person's own turn is told to wait", async () => {
    asked.length = 0;
    const [ask] = await tools("group").toolsForRun(run);
    const text = await withApprovalContext(
      { ...context, initiator: { kind: "person" as const } },
      () => ask?.execute({ question: "Which budget?" }) as Promise<string>,
    );
    expect(text).toContain("That was not put to anybody yet");
    expect(asked).toEqual([]);
  });

  test("a question only the owner reads goes straight through", async () => {
    asked.length = 0;
    const [ask] = await tools("owner").toolsForRun(run);
    await ask?.execute({ question: "Which budget?" });
    expect(asked).toEqual(["Which budget?"]);
  });
});

describe("host commands", () => {
  const grant = {
    id: "grant-1",
    botId: "bot",
    actorId: "owner",
    displayName: "Project",
    revoked: false,
  };
  test("never is refused before anything reaches the computer", async () => {
    const broker = createHostAccessBroker(Date.now, {
      commandPolicy: async () => "never",
    });
    broker.rememberGrant(grant);
    await expect(
      broker.callHost({
        kind: "run_command",
        botId: "bot",
        actorId: "owner",
        grantId: "grant-1",
        command: "ls",
      }),
    ).rejects.toThrow("set to never run");
    expect(broker.nextDesktopOperation()).toBeNull();
  });

  test("the effective policy travels with the command to the native dialog", async () => {
    const broker = createHostAccessBroker(Date.now, {
      commandPolicy: async () => "allow",
    });
    broker.rememberGrant(grant);
    const call = broker.callHost({
      kind: "run_command",
      botId: "bot",
      actorId: "owner",
      grantId: "grant-1",
      command: "ls",
    });
    await Bun.sleep(0);
    const lease = broker.nextDesktopOperation();
    expect(lease?.operations[0]).toMatchObject({
      kind: "run_command",
      command: "ls",
      commandPolicy: "allow",
    });
    broker.resolveDesktopOperation({
      operationId: lease?.operations[0]?.operationId as string,
      ok: true,
      result: { stdout: "" },
    });
    await expect(call).resolves.toEqual({ stdout: "" });
  });
});
