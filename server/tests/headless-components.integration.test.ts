import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { inArray } from "drizzle-orm";
import { Observable } from "rxjs";
import { GALLERY } from "../../app/src/components/gallery/charts";
import { NOT_SHOWN } from "../../shared/component-markers";
import type { AuditEventInput } from "../src/audit";
import { createHeadlessComponentTools } from "../src/components/headless";
import { createComponentStore } from "../src/components/store";
import { createComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import { agents, componentExclusions, components } from "../src/db/schema";
import { createTurnRunner, type RunnerLike } from "../src/routines/run-turn";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An unattended routine turn that browses a page and answers with a chart, against the real
 * component governance tables. The Intelligence runner and the remote Bot are local seams; this is
 * not a live model, Kubernetes or browser validation.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createComponentStore(database);
const suite = randomUUID().slice(0, 8);
const allowedBot = `agent_headless_chart_${suite}`;
const deniedBot = `agent_headless_withheld_${suite}`;
let addedComponents: string[] = [];

const chartArgs = {
  title: "Stories on the front page by source",
  caption: "Read from the page the routine opened.",
  points: [
    { label: "github.com", value: 4 },
    { label: "nytimes.com", value: 2 },
  ],
};

beforeAll(async () => {
  for (const id of [allowedBot, deniedBot])
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
  // What the browser announces on first load, so the rows are the build's own declarations.
  ({ added: addedComponents } = await store.syncCatalogue(
    GALLERY.map(({ name, title, kind, description }) => ({
      name,
      title,
      kind,
      description,
    })),
  ));
  const decision = await store.decide("showBarChart", allowedBot);
  if (!decision.allowed)
    throw new Error(
      `The test database has showBarChart unpublished: ${decision.reason}`,
    );
  await store.revoke("showBarChart", deniedBot, "test@openbot.local");
});

afterAll(async () => {
  await database
    .delete(componentExclusions)
    .where(inArray(componentExclusions.agentId, [allowedBot, deniedBot]));
  if (addedComponents.length > 0)
    await database
      .delete(components)
      .where(inArray(components.name, addedComponents));
  await database
    .delete(agents)
    .where(inArray(agents.id, [allowedBot, deniedBot]));
});

function lifecycle(input: RunAgentInput, body: BaseEvent[]): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent,
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent,
  ];
}

function call(id: string, name: string, args: unknown): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `message-${id}`,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ] as BaseEvent[];
}

function reply(text: string): BaseEvent[] {
  return [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ] as BaseEvent[];
}

/** A remote AG-UI Bot that opens a page, charts it, then answers. */
function remoteBot() {
  const requests: RunAgentInput[] = [];
  const agent = new HttpAgent({
    agentId: "bot",
    url: "https://agent.example/ag-ui",
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as RunAgentInput;
      requests.push(input);
      const body =
        requests.length === 1
          ? call("navigate-call", "computer_navigate", {
              url: "https://news.example/",
            })
          : requests.length === 2
            ? call("chart-call", "showBarChart", chartArgs)
            : reply("I charted the front page for you.");
      return new Response(
        lifecycle(input, body)
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { agent, requests };
}

function harness(agent: AbstractAgent, botId: string) {
  const persisted: BaseEvent[] = [];
  const audit: AuditEventInput[] = [];
  const auditStore = {
    insert: async (event: AuditEventInput) => {
      audit.push(event);
    },
  };
  const visited: string[] = [];
  const gateway = createComputerGateway({
    provider: {
      name: "test",
      isolation: "per-bot",
      locate: async () => "http://computer:4100",
      status: async (id) => ({ botId: id, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    },
    auditStore,
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/navigate")
        throw new Error(`Unexpected computer request ${path}`);
      visited.push(JSON.parse(String(init?.body)).url);
      return Response.json({
        url: "https://news.example/",
        title: "News",
        text: "github.com 4 stories, nytimes.com 2 stories",
        truncated: false,
        elapsedMs: 1,
      });
    },
  });
  const runner: RunnerLike = {
    run: ({ agent: selected, input }) =>
      new Observable((subscriber) => {
        selected
          .runAgent(input, {
            onEvent: ({ event }) => {
              persisted.push(event);
              subscriber.next(event);
            },
          })
          .then(
            () => subscriber.complete(),
            (error) => subscriber.error(error),
          );
      }),
    stop: async () => true,
  };
  const run = createTurnRunner({
    intelligence: {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => undefined,
      ɵrenewThreadLock: async () => undefined,
      ɵcleanupThreadLock: async () => undefined,
    },
    runner,
    buildAgentFor: async () => agent,
    toolsForTurn: async ({ ownerUserId, initiator }) =>
      createHeadlessComputerTools({
        gateway,
        botId,
        actor: { id: ownerUserId, userId: ownerUserId, initiator },
      }),
    components: { store, auditStore },
  });
  return {
    persisted,
    audit,
    visited,
    run: () =>
      run({
        ownerUserId: "owner",
        routineId: "routine-front-page",
        agentId: botId,
        threadId: `thread-${botId}`,
        instruction: "Chart today's front page by source",
      }),
  };
}

function resultFor(persisted: BaseEvent[], toolCallId: string) {
  return persisted.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT &&
      (event as { toolCallId?: string }).toolCallId === toolCallId,
  ) as { content: string } | undefined;
}

describe("an unattended routine turn answering with a governed chart", () => {
  test("browses, records the chart as its component in the persisted transcript, and replies", async () => {
    const remote = remoteBot();
    const turn = harness(remote.agent, allowedBot);

    // The chart comes back with the reply, so a chat surface (Teams, Slack) can draw it natively.
    await expect(turn.run()).resolves.toEqual({
      replyText: "I charted the front page for you.",
      components: [{ name: "showBarChart", args: chartArgs }],
    });

    expect(turn.visited).toEqual(["https://news.example/"]);
    // Offered with the deployment's published wording, as the browser would offer it.
    const offered = remote.requests[0]?.tools.find(
      (tool) => tool.name === "showBarChart",
    );
    expect(offered?.description).toBe(
      GALLERY.find((entry) => entry.name === "showBarChart")?.description,
    );

    // The persisted events are what the transcript renderer reads: the call by component name with
    // its arguments, and a result that is not a refusal.
    const start = turn.persisted.find(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        (event as { toolCallId?: string }).toolCallId === "chart-call",
    ) as { toolCallName: string } | undefined;
    expect(start?.toolCallName).toBe("showBarChart");
    const args = turn.persisted
      .filter(
        (event) =>
          event.type === EventType.TOOL_CALL_ARGS &&
          (event as { toolCallId?: string }).toolCallId === "chart-call",
      )
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(JSON.parse(args)).toEqual(chartArgs);
    const result = resultFor(turn.persisted, "chart-call");
    expect(result?.content).toBe(
      "The bar chart is saved in this conversation and is drawn when the person opens it.",
    );
    expect(resultFor(turn.persisted, "navigate-call")?.content).toContain(
      '"title":"News"',
    );
    // The Bot saw the result and continued the same AG-UI run.
    expect(remote.requests[2]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool", toolCallId: "chart-call" }),
    );
    expect(
      turn.persisted.filter((event) => event.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    expect(
      turn.persisted.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
    expect(
      turn.audit.filter((event) => event.eventType.startsWith("component.")),
    ).toEqual([]);
  });

  test("a Bot withheld from the chart is not offered it, and a call anyway is recorded as not shown", async () => {
    const remote = remoteBot();
    const turn = harness(remote.agent, deniedBot);

    await expect(turn.run()).resolves.toEqual({
      replyText: "I charted the front page for you.",
    });

    expect(
      remote.requests[0]?.tools.some((tool) => tool.name === "showBarChart"),
    ).toBeFalse();
    const result = resultFor(turn.persisted, "chart-call");
    expect(result?.content.startsWith(`${NOT_SHOWN}Bar chart. `)).toBeTrue();
    expect(result?.content).toContain("withheld from this Bot");
    expect(turn.audit).toContainEqual(
      expect.objectContaining({
        eventType: "component.refused",
        targetType: "component",
        targetId: "showBarChart",
        actorUserId: "owner",
        initiator: { kind: "routine", id: "routine-front-page" },
        payload: expect.objectContaining({ bot: deniedBot, headless: true }),
      }),
    );
  });

  test("a grant revoked after the turn started is refused at call time", async () => {
    const tools = await createHeadlessComponentTools({
      store,
      botId: allowedBot,
      ownerUserId: "owner",
      initiator: { kind: "routine", id: "routine-front-page" },
    });
    const bar = tools.find((tool) => tool.definition.name === "showBarChart");
    expect(bar?.hidden).toBeUndefined();
    await store.revoke("showBarChart", allowedBot, "test@openbot.local");
    try {
      const result = String(
        await bar?.execute(chartArgs, {
          toolCallId: "late",
          signal: new AbortController().signal,
        }),
      );
      expect(result.startsWith(NOT_SHOWN)).toBeTrue();
    } finally {
      await store.grant("showBarChart", allowedBot);
    }
  });
});
