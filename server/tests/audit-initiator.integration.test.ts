import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditQueryFromUrl,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createAuditStore(database);
const reader = createAuditReader(database);

// Nothing is cleaned up: the retention trigger refuses the delete, so each test takes its own target id.
const target = () => `initiator-test-${crypto.randomUUID()}`;

async function rowsFor(targetId: string, search = "") {
  const { events } = await reader.list(
    auditQueryFromUrl(new URL(`https://openbot.test/audit${search}`)),
  );
  return events.filter((event) => event.targetId === targetId);
}

describe("what started a run", () => {
  test("a person's action is the default, and needs nothing passed", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      payload: { bot: "general-assistant" },
    });

    const [row] = await rowsFor(TARGET);

    expect(row?.initiatorKind).toBe("person");
    expect(row?.initiatorId).toBeNull();
  });

  test("a routine's action names the routine, not only the owner", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      actorUserId: null as unknown as undefined,
      initiator: { kind: "routine", id: "routine-7" },
      payload: { bot: "general-assistant" },
    });

    const [row] = await rowsFor(TARGET);

    expect(row?.initiatorKind).toBe("routine");
    expect(row?.initiatorId).toBe("routine-7");
  });

  test("a hop names the Bot that handed the work on", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "agent.handoff_delivered",
      targetType: "agent",
      targetId: TARGET,
      initiator: { kind: "handoff", id: "research-assistant" },
      payload: { bot: "general-assistant" },
    });

    const [row] = await rowsFor(TARGET);

    expect(row?.initiatorKind).toBe("handoff");
    expect(row?.initiatorId).toBe("research-assistant");
  });

  test("the deployment acting as itself is not filed as a person", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "computer.policy_loaded",
      targetType: "policy",
      targetId: TARGET,
      initiator: { kind: "deployment" },
      payload: { note: "read at start-up" },
    });

    const [row] = await rowsFor(TARGET);

    expect(row?.initiatorKind).toBe("deployment");
    expect(row?.initiatorId).toBeNull();
  });

  test("a boundary refusal is the deployment, and is not swept up by nobody watching", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "routines.dispatch_refused",
      targetType: "worker",
      targetId: TARGET,
      initiator: { kind: "deployment" },
      payload: { marker: "by-deployment" },
    });
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      initiator: { kind: "routine", id: "routine-7" },
      payload: { marker: "by-routine" },
    });

    const unattended = await rowsFor(TARGET, "?initiatorKind=routine,handoff");
    const deployment = await rowsFor(TARGET, "?initiatorKind=deployment");

    expect(unattended.map((event) => event.payload.marker)).toEqual([
      "by-routine",
    ]);
    expect(deployment.map((event) => event.payload.marker)).toEqual([
      "by-deployment",
    ]);
  });

  test("one filter answers what ran with nobody watching", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      payload: { marker: "by-hand" },
    });
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      initiator: { kind: "routine", id: "routine-7" },
      payload: { marker: "by-routine" },
    });
    await store.insert({
      eventType: "agent.handoff_delivered",
      targetType: "agent",
      targetId: TARGET,
      initiator: { kind: "handoff", id: "research-assistant" },
      payload: { marker: "by-hop" },
    });

    const unattended = await rowsFor(TARGET, "?initiatorKind=routine,handoff");

    expect(unattended.map((event) => event.payload.marker).sort()).toEqual([
      "by-hop",
      "by-routine",
    ]);
  });

  test("one kind on its own narrows to that kind", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      initiator: { kind: "routine", id: "routine-7" },
      payload: { marker: "by-routine" },
    });
    await store.insert({
      eventType: "agent.handoff_delivered",
      targetType: "agent",
      targetId: TARGET,
      initiator: { kind: "handoff", id: "research-assistant" },
      payload: { marker: "by-hop" },
    });

    const routines = await rowsFor(TARGET, "?initiatorKind=routine");

    expect(routines.map((event) => event.payload.marker)).toEqual([
      "by-routine",
    ]);
  });

  test("a kind nothing writes is ignored rather than returning nothing", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      payload: { marker: "by-hand" },
    });

    const rows = await rowsFor(TARGET, "?initiatorKind=nonsense");

    expect(rows.map((event) => event.payload.marker)).toEqual(["by-hand"]);
  });

  test("the trail stays append-only, so a row cannot be re-attributed later", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      initiator: { kind: "routine", id: "routine-7" },
      payload: { bot: "general-assistant" },
    });

    const reattribute = async () => {
      await database
        .update(auditEvents)
        .set({ initiatorKind: "person", initiatorId: null })
        .where(eq(auditEvents.targetId, TARGET));
    };

    expect(reattribute()).rejects.toThrow();
  });
});
