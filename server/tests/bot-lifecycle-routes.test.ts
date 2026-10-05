import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { BotPausedError } from "../src/agents/lifecycle";
import { createBotLifecycleRoutes } from "../src/agents/lifecycle-routes";
import { createWakeUpRunner, type WakeUpPayload } from "../src/agents/wake-up";
import type { AuditEventInput } from "../src/audit";

const ACTOR = { id: "u1", email: "person@openbot.test", role: "user" } as const;

function app() {
  const rows: AuditEventInput[] = [];
  const calls: string[] = [];
  const state = { paused: false, notify: "all" as string };
  const services = {
    lifecycle: {
      get: async () => ({
        agentId: "bot-1",
        paused: state.paused,
        pausedAt: null,
        notify: state.notify,
      }),
      pause: async (owner: string) => {
        calls.push(`pause:${owner}`);
        state.paused = true;
        return 2;
      },
      resume: async () => {
        state.paused = false;
      },
      setNotify: async (_o: string, _a: string, notify: string) => {
        state.notify = notify;
      },
      pausedFor: async () => (state.paused ? ["bot-1"] : []),
      notifyFor: async () => ({}),
      routing: async () => ({
        progress: "all",
        decision: "all",
        question: "all",
      }),
      setRouting: async () => {},
    },
    reset: {
      plan: async () => ({ conversations: 3 }),
      execute: async (actor: { id: string }) => {
        calls.push(`reset:${actor.id}`);
        return { conversations: 3 };
      },
    },
    activity: {
      forBot: async () => ({ inProgress: [], scheduled: [], completed: [] }),
      stopHandoff: async (_o: string, _a: string, key: string) =>
        key === "hop-1" ? { key, toBotId: "bot-2" } : null,
      attention: async () => [
        {
          agentId: "bot-1",
          questions: 1,
          approvals: 0,
          handoffs: 0,
          unread: 2,
        },
        {
          agentId: "hidden-bot",
          questions: 4,
          approvals: 0,
          handoffs: 0,
          unread: 0,
        },
      ],
    },
    wakeUps: { cancel: async () => true },
    profiles: {
      get: async (_actor: unknown, id: string) =>
        id === "bot-1" ? { id: "bot-1", name: "Sales" } : null,
    },
    auditStore: {
      insert: async (event: AuditEventInput) => void rows.push(event),
    },
  } as never;
  const requireUser = async (
    context: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    context.set("actor", ACTOR);
    await next();
  };
  const hono = new Hono().route(
    "/api/bots",
    createBotLifecycleRoutes(services, requireUser as never),
  );
  return { rows, calls, hono, state };
}

const post = (body?: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("Bot lifecycle routes", () => {
  test("pause and resume act for the caller and are audited", async () => {
    const { rows, calls, hono } = app();
    const paused = await hono.request("http://t/api/bots/bot-1/pause", post());
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      lifecycle: { paused: true },
      stoppedTurns: 2,
    });
    expect(calls).toEqual(["pause:u1"]);
    await hono.request("http://t/api/bots/bot-1/resume", post());
    expect(rows.map((row) => row.eventType)).toEqual([
      "bot.paused",
      "bot.resumed",
    ]);
    expect(rows[0]?.payload.stoppedTurns).toBe(2);
  });

  test("a Bot the caller cannot reach is not found, and nothing happens", async () => {
    const { rows, calls, hono } = app();
    const response = await hono.request(
      "http://t/api/bots/someone-elses/pause",
      post(),
    );
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("reset shows its notice first and refuses without an explicit confirm", async () => {
    const { rows, calls, hono } = app();
    const notice = await hono.request("http://t/api/bots/bot-1/reset");
    expect(await notice.json()).toEqual({ plan: { conversations: 3 } });
    const refused = await hono.request(
      "http://t/api/bots/bot-1/reset",
      post({}),
    );
    expect(refused.status).toBe(400);
    expect(calls).toEqual([]);
    const done = await hono.request(
      "http://t/api/bots/bot-1/reset",
      post({ confirm: true }),
    );
    expect(done.status).toBe(200);
    expect(calls).toEqual(["reset:u1"]);
    expect(rows[0]?.eventType).toBe("bot.reset");
  });

  test("notification preference is validated and audited", async () => {
    const { rows, hono } = app();
    const bad = await hono.request("http://t/api/bots/bot-1/notifications", {
      ...post({ notify: "loud" }),
      method: "PUT",
    });
    expect(bad.status).toBe(400);
    const good = await hono.request("http://t/api/bots/bot-1/notifications", {
      ...post({ notify: "needs_input" }),
      method: "PUT",
    });
    expect(await good.json()).toMatchObject({
      lifecycle: { notify: "needs_input" },
    });
    expect(rows[0]?.eventType).toBe("bot.notifications_changed");
  });

  test("attention lists only Bots the caller can still reach", async () => {
    const { hono } = app();
    const response = await hono.request("http://t/api/bots/attention");
    const { bots } = (await response.json()) as { bots: { agentId: string }[] };
    expect(bots.map((row) => row.agentId)).toEqual(["bot-1"]);
  });

  test("stopping a delegated task is audited; an unknown one is a 404", async () => {
    const { rows, hono } = app();
    const missing = await hono.request(
      "http://t/api/bots/bot-1/activity/handoffs/stop",
      post({ id: "nope" }),
    );
    expect(missing.status).toBe(404);
    const stopped = await hono.request(
      "http://t/api/bots/bot-1/activity/handoffs/stop",
      post({ id: "hop-1" }),
    );
    expect(stopped.status).toBe(200);
    expect(rows[0]).toMatchObject({
      eventType: "bot.handoff_stopped",
      payload: { hop: "hop-1", to: "bot-2" },
    });
  });
});

describe("follow-up runner", () => {
  const payload: WakeUpPayload = {
    ownerUserId: "u1",
    agentId: "bot-1",
    reason: "check the build",
    dueAt: new Date().toISOString(),
    scheduledAt: new Date().toISOString(),
  };
  function runner(runTurn: () => Promise<{ replyText: string }>) {
    const settled: string[] = [];
    const said: string[] = [];
    const notified: string[] = [];
    const instructions: string[] = [];
    const wake = createWakeUpRunner({
      queue: {
        claim: async () => [
          { kind: "bot.wakeup", key: "w1", payload, attempts: 1 },
        ],
        finish: async () => true,
        purge: async () => 0,
      },
      store: {
        settle: async (_id: string, outcome: { status: string }) =>
          void settled.push(outcome.status),
      } as never,
      owner: "replica",
      actorFor: async (id) => ({ id, role: "user" }),
      channels: {
        get: async () => null,
        direct: async () => ({
          id: "c1",
          threadId: "t1",
          name: "",
          agentIds: [],
          active: true,
          lastMessageAt: null,
        }),
        recordActivity: async (_a, _c, activity) =>
          void said.push(activity.text),
      },
      runTurn: async (input) => {
        instructions.push(input.instruction);
        return runTurn();
      },
      notify: async (_scope, input) => void notified.push(input.text),
    });
    return { wake, settled, said, notified, instructions };
  }

  test("a due follow-up runs one turn in the person's conversation and tells them", async () => {
    const { wake, settled, said, notified, instructions } = runner(
      async () => ({
        replyText: "The build is green.",
      }),
    );
    expect(await wake.sweep()).toEqual({ ran: ["w1"], skipped: [] });
    expect(instructions[0]).toContain("check the build");
    expect(said).toEqual(["The build is green."]);
    expect(notified).toEqual(["The build is green."]);
    expect(settled).toEqual(["succeeded"]);
  });

  test("a paused Bot's follow-up is skipped and nothing is said", async () => {
    const { wake, settled, said, notified } = runner(async () => {
      throw new BotPausedError();
    });
    expect(await wake.sweep()).toEqual({ ran: [], skipped: ["w1"] });
    expect(settled).toEqual(["skipped"]);
    expect(said).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("a failed turn is recorded once and never retried", async () => {
    const { wake, settled } = runner(async () => {
      throw new Error("model refused");
    });
    await wake.sweep();
    expect(settled).toEqual(["failed"]);
  });
});
