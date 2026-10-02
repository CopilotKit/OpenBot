import { describe, expect, test } from "bun:test";
import {
  mintRunAssertion,
  type RunAssertion,
} from "../src/agents/callback-token";
import { createApp, type DeploymentToolCaller } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";
import {
  createCoordinationTools,
  authoriseCoordinationRun,
} from "../src/agents/handoff-tool";
import type { HandoffWork } from "../src/agents/handoff-runner";
import type { AuditStore } from "../src/audit";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TOKEN = "remote-coordination-test-token";
const RUN: RunAssertion = {
  botId: "remote-researcher",
  actorId: "person-1",
  threadId: "source-thread",
  runId: "delivery-run",
  depth: 1,
  initiator: { kind: "routine", id: "routine-1" },
};

function callbackApp(caller: DeploymentToolCaller) {
  const parameters: Parameters<typeof createApp> = [
    loadConfig(
      testEnvironment({ AGENT_TOOL_TOKEN: TOKEN, KEY_ENCRYPTION_KEY: KEY }),
    ),
  ];
  parameters[28] = caller;
  return createApp(...parameters);
}

describe("remote coordination on the signed tool callback", () => {
  test("carries the entire signed run instead of caller supplied scope", async () => {
    const captured: Parameters<DeploymentToolCaller>[0][] = [];
    const app = callbackApp(async (input) => {
      captured.push(input);
      return { text: "queued", isError: false };
    });

    const response = await app.request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOKEN,
      },
      body: JSON.stringify({
        name: "message_bot",
        args: { bot: "knowledge", task: "Find the incident" },
        botId: "another-bot",
        actorId: "another-person",
        threadId: "another-thread",
        depth: 0,
        initiator: { kind: "person" },
        run: mintRunAssertion(DELEGATED, KEY),
      }),
    });

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      name: "message_bot",
      botId: RUN.botId,
      actorId: RUN.actorId,
      initiator: RUN.initiator,
      run: DELEGATED,
    });
  });

  test.each([
    ["an unknown token", "unknown-token", mintRunAssertion(RUN, KEY)],
    ["an expired run", TOKEN, mintRunAssertion(RUN, KEY, 0)],
    ["a forged run", TOKEN, mintRunAssertion(RUN, "another-key")],
  ])("refuses %s before dispatch", async (_label, presented, run) => {
    let dispatched = false;
    const app = callbackApp(async () => {
      dispatched = true;
      return { text: "queued", isError: false };
    });
    const response = await app.request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": presented,
      },
      body: JSON.stringify({
        name: "ask_person",
        args: { question: "Which team?" },
        run,
      }),
    });
    expect(response.status).toBe(401);
    expect(dispatched).toBe(false);
  });
});

const WORK: HandoffWork = {
  fromBotId: "source-bot",
  toBotId: RUN.botId,
  actorId: RUN.actorId,
  threadId: RUN.threadId!,
  runId: "original-run",
  depth: 1,
  initiator: RUN.initiator,
  task: "Investigate the incident",
};
const DELEGATED: RunAssertion = {
  ...RUN,
  handoff: { key: "hop-key", owner: "pod-1" },
};

function authority(
  over: {
    canUseBot?: boolean;
    thread?: { botId: string } | null;
    work?: HandoffWork;
    owner?: string;
    active?: boolean;
  } = {},
) {
  return {
    canUseBot: async () => over.canUseBot ?? true,
    sourceThread: async () =>
      over.thread === undefined ? { botId: "source-bot" } : over.thread,
    delegationFor: async () => ({
      work: over.work ?? WORK,
      owner: over.owner ?? "pod-1",
      active: over.active ?? true,
    }),
  };
}

describe("coordination run authority", () => {
  test("a signed delivery keeps its source thread and current lease owner", async () => {
    expect(await authoriseCoordinationRun(DELEGATED, authority())).toBe(true);
    expect(
      await authoriseCoordinationRun(
        { ...RUN, depth: 0, botId: "source-bot" },
        authority(),
      ),
    ).toBe(true);
  });

  test.each([
    ["missing delegation", RUN, authority()],
    ["another lease owner", DELEGATED, authority({ owner: "pod-2" })],
    ["an expired lease", DELEGATED, authority({ active: false })],
    [
      "another source thread",
      { ...DELEGATED, threadId: "unrelated-thread" },
      authority(),
    ],
    ["another actor", { ...DELEGATED, actorId: "another-person" }, authority()],
    ["another target", { ...DELEGATED, botId: "another-bot" }, authority()],
    ["another depth", { ...DELEGATED, depth: 2 }, authority()],
    [
      "another initiator",
      { ...DELEGATED, initiator: { kind: "person" } },
      authority(),
    ],
    ["lost source membership", DELEGATED, authority({ thread: null })],
    ["lost Bot access", DELEGATED, authority({ canUseBot: false })],
    ["wrong direct Bot", { ...RUN, depth: 0 }, authority()],
  ])("refuses %s", async (_label, run, dependencies) => {
    expect(
      await authoriseCoordinationRun(run as RunAssertion, dependencies),
    ).toBe(false);
  });
});

describe("the common coordination tools", () => {
  function tools(
    options: { granted?: boolean; authorised?: boolean; depth?: number } = {},
  ) {
    const sent: RunAssertion[] = [];
    const questions: {
      actorId: string;
      botId: string;
      threadId?: string;
      runId: string;
      question: string;
    }[] = [];
    const audit: Parameters<AuditStore["insert"]>[0][] = [];
    const coordinator = createCoordinationTools({
      desk: {
        send: async ({ from }) => {
          sent.push(from);
          if ((from.depth ?? 0) >= 2)
            return { ok: false, refusal: "At the depth cap." };
          if (options.granted === false)
            return { ok: false, refusal: "The grant was revoked." };
          return { ok: true, to: "knowledge", toName: "Knowledge" };
        },
      },
      caps: { maxDepth: 2, maxPerRun: 1 },
      botsReachableFrom: async () =>
        options.granted === false ? [] : ["knowledge"],
      route: async (question) => {
        questions.push(question);
        return { reached: "the source conversation's person" };
      },
      auditStore: {
        insert: async (event) => {
          audit.push(event);
        },
      },
      authoriseRun: async () => options.authorised ?? true,
    });
    return { coordinator, sent, questions, audit };
  }

  test("offers both schemas for remote runs and keeps ask_person at the handoff cap", async () => {
    const { coordinator } = tools();
    const offered = await coordinator.toolsForRun(DELEGATED);
    expect(offered.map((tool) => tool.name)).toEqual([
      "message_bot",
      "ask_person",
    ]);
    expect(
      offered[0]?.parameters.safeParse({
        bot: "Knowledge",
        task: "Investigate",
      }).success,
    ).toBe(true);
    expect(
      (await coordinator.toolsForRun({ ...DELEGATED, depth: 2 })).map(
        (tool) => tool.name,
      ),
    ).toEqual(["ask_person"]);
  });

  test("executes a handoff with the signed context and reports a revoked grant as an error", async () => {
    const { coordinator, sent } = tools({ granted: false });
    const result = await coordinator.call({
      name: "message_bot",
      args: { bot: "Knowledge", task: "Investigate" },
      run: DELEGATED,
    });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("The grant was revoked");
    expect(sent).toEqual([DELEGATED]);
  });

  test("asks the canonical source person and preserves the routine initiator in audit", async () => {
    const { coordinator, questions, audit } = tools();
    const result = await coordinator.call({
      name: "ask_person",
      args: { question: "Which team owns this?" },
      run: DELEGATED,
    });
    expect(result?.isError).toBe(false);
    expect(questions[0]).toMatchObject({
      actorId: RUN.actorId,
      botId: RUN.botId,
      threadId: "source-thread",
      runId: RUN.runId,
    });
    expect(audit[0]).toMatchObject({
      eventType: "agent.escalated",
      initiator: RUN.initiator,
    });
  });

  test("an unrelated source thread is refused before either tool executes and is audited", async () => {
    const { coordinator, sent, questions, audit } = tools({
      authorised: false,
    });
    for (const name of ["message_bot", "ask_person"]) {
      expect(
        (await coordinator.call({ name, args: {}, run: DELEGATED }))?.isError,
      ).toBe(true);
    }
    expect(sent).toEqual([]);
    expect(questions).toEqual([]);
    expect(audit).toHaveLength(2);
    expect(audit[0]?.initiator).toEqual(RUN.initiator);
  });
});
