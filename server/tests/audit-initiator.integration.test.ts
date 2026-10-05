import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditQueryFromUrl,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createAuditStore(database);
const reader = createAuditReader(database);

// Nothing is cleaned up: the retention trigger refuses the delete, so each test takes its own target id.
const target = () => `initiator-test-${crypto.randomUUID()}`;

/**
 * The page a filter actually answers with, across every row in the trail.
 *
 * `rowsFor` narrows to one test's target afterwards, which is what makes the tests independent —
 * but it also hides the difference between a filter that matched one row and a filter that matched
 * the entire trail and was then cut down here. A filter that must narrow to nothing is only shown
 * to have done so by reading the page before that cut.
 */
async function pageFor(search = "") {
  const { events } = await reader.list(
    auditQueryFromUrl(new URL(`https://openbot.test/audit${search}`)),
  );
  return events;
}

async function rowsFor(targetId: string, search = "") {
  const events = await pageFor(search);
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

  /*
   * The filter that fails closed.
   *
   * An unrecognised kind used to be dropped from the requested set, and a requested set left empty
   * added no condition at all — so `?initiatorKind=nonsense` answered with the entire unfiltered
   * trail, and nothing in the response said so. On a record of whose credential was spent on what,
   * the wrong direction to fail is the one that hands back everything.
   */
  test("a kind nothing writes narrows to nothing, not to the whole trail", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      payload: { marker: "by-hand" },
    });

    const page = await pageFor("?initiatorKind=nonsense");

    expect(page).toEqual([]);
  });

  test("an unknown kind beside a known one still answers for the known one", async () => {
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

    const rows = await rowsFor(TARGET, "?initiatorKind=routine,nonsense");

    expect(rows.map((event) => event.payload.marker)).toEqual(["by-routine"]);
  });

  /*
   * The same collapse, reached by punctuation rather than by a typo, on both comma-separated
   * filters: a value that is nothing but separators narrows to an empty set the same way an
   * unrecognised kind does, and an empty set must never widen back into no condition.
   */
  test("a filter that is only separators narrows to nothing on either column", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      payload: { marker: "by-hand" },
    });

    expect(await pageFor("?initiatorKind=,")).toEqual([]);
    expect(await pageFor("?eventType=,")).toEqual([]);
  });

  /*
   * And the other direction, so the fix cannot overshoot: a blank value is a parameter nobody
   * filled in, read as absent here the way a blank `?limit=` still reads as the default page.
   */
  test("a blank filter is an absent filter, not one that names nothing", async () => {
    const TARGET = target();
    await store.insert({
      eventType: "mcp.call_succeeded",
      targetType: "mcp_tool",
      targetId: TARGET,
      payload: { marker: "by-hand" },
    });

    expect(
      (await rowsFor(TARGET, "?initiatorKind=")).map(
        (event) => event.payload.marker,
      ),
    ).toEqual(["by-hand"]);
    expect(
      (await rowsFor(TARGET, "?eventType=%20")).map(
        (event) => event.payload.marker,
      ),
    ).toEqual(["by-hand"]);
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
