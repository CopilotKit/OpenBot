import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { StaleSnapshotError } from "../src/computer/client";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createInMemorySnapshotStore } from "../src/computer/snapshot-store";
import { createDockerSupervisorProvider } from "../src/computer/supervisor";

/**
 * A ref is only meaningful for the run of the computer that produced it.
 *
 * A replaced container counts its generations from one again, so a ref from the run before matches a
 * stored row nothing has overwritten and resolves to an element on a page that is gone. The server
 * compares the run to tell the two apart, and these are the cases where that comparison has to hold:
 * the first action after a replacement, every action after that, and an action that landed on a
 * replica which has never located this Bot itself.
 */

const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const ACTOR = { id: "dev-local-user" };

const FIRST_RUN = "2026-08-25T10:00:00.000Z";
const SECOND_RUN = "2026-08-25T11:30:00.000Z";

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

/**
 * The supervisor, answering for whatever container exists now.
 *
 * Both endpoints report the same run, because a real supervisor does: `/ensure` and `/computers`
 * read the same container. A stub that lists nothing would let these tests pass on an absence the
 * deployment does not have, and `sessionOf` falls back to listing when it has not located a Bot
 * itself. So every Bot named here is listed, whether or not this process ensured it.
 */
function fakeSupervisor(startedAt: () => string, known: string[] = []) {
  const ensured = new Set(known);
  const describe = (botId: string) => ({
    botId,
    container: `openbot-computer-${botId}`,
    status: "running",
    url: "http://openbot-computer:4100",
    startedAt: startedAt(),
  });
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/ensure")) {
      const asked = decodeURIComponent(
        path.slice("/computers/".length, -"/ensure".length),
      );
      ensured.add(asked);
      return Response.json(describe(asked));
    }
    return Response.json({
      computers: [...ensured].map((botId) => describe(botId)),
    });
  }) as unknown as typeof fetch;
}

function fakeComputerFetch() {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/snapshot") return Response.json(SNAPSHOT);
    if (path === "/click")
      return Response.json({
        action: "click",
        url: SNAPSHOT.url,
        elapsedMs: 1,
      });
    return Response.json({ error: path }, { status: 404 });
  }) as unknown as typeof fetch;
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

/** One server replica: its own provider, its own gateway, sharing only the snapshot store. */
function stack(
  startedAt: () => string,
  policy: ActionPolicy = PERMISSIVE,
  known: string[] = [],
) {
  const snapshots = createInMemorySnapshotStore();
  const provider = createDockerSupervisorProvider({
    baseUrl: "http://supervisor:4300",
    fetchImpl: fakeSupervisor(startedAt, known),
  });
  const { store, rows } = fakeAudit();
  const gateway = createComputerGateway({
    provider,
    fetchImpl: fakeComputerFetch(),
    auditStore: store,
    policy: () => policy,
    snapshots,
  });
  return { provider, gateway, rows, snapshots };
}

describe("a ref outliving the computer that produced it", () => {
  test("the first action after the computer is replaced is refused, not the second", async () => {
    let run = FIRST_RUN;
    const { gateway, rows } = stack(() => run);

    const taken = await gateway.snapshot("bot-a");
    expect(taken.snapshotId).toBe(7);

    // The supervisor replaces the container because the image tag moved. Generations start from one
    // again, nothing clears the stored snapshot, and the server is never told.
    run = SECOND_RUN;

    const first = await gateway
      .click("bot-a", ACTOR, { ref: "e9", snapshotId: taken.snapshotId })
      .catch((error: unknown) => error);
    expect(first).toBeInstanceOf(StaleSnapshotError);

    // The audit row must not name a button on a page that is gone.
    expect(JSON.stringify(rows.at(-1)?.payload.element ?? "")).not.toContain(
      "Submit order",
    );

    const second = await gateway
      .click("bot-a", ACTOR, { ref: "e9", snapshotId: taken.snapshotId })
      .catch((error: unknown) => error);
    expect(second).toBeInstanceOf(StaleSnapshotError);
  });

  test("a replica that never located the Bot itself refuses too", async () => {
    // This process has never called `/ensure` for bot-c, so it holds nothing for it. The snapshot row
    // was written by the replica that took it and carries the run it belongs to.
    const { gateway, snapshots } = stack(() => SECOND_RUN, PERMISSIVE, [
      "bot-c",
    ]);
    await snapshots.save("bot-c", {
      snapshotId: 7,
      url: SNAPSHOT.url,
      elements: new Map(SNAPSHOT.elements.map((e) => [e.ref, e])),
      session: FIRST_RUN,
    });

    const clicked = await gateway
      .click("bot-c", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((error: unknown) => error);
    expect(clicked).toBeInstanceOf(StaleSnapshotError);
  });

  test("a deny rule stops naming an element from a run that has ended", async () => {
    // The sharper failure: with a rule keyed on the element's name, the server refused on the dead
    // run's element and sent nothing, so the computer's own generation check never got a say. The
    // refusal named a rule about a button the Bot never touched.
    let run = FIRST_RUN;
    const { gateway } = stack(() => run, {
      mode: "enforce",
      deny: ['contains(element.name, "Submit order")'],
      allow: ["true"],
    });

    const taken = await gateway.snapshot("bot-d");
    run = SECOND_RUN;

    const clicked = await gateway
      .click("bot-d", ACTOR, { ref: "e9", snapshotId: taken.snapshotId })
      .catch((error: unknown) => error);
    expect(clicked).not.toBeInstanceOf(ActionRefusedError);
    expect(clicked).toBeInstanceOf(StaleSnapshotError);
  });

  test("the run is read per provider, not once per process", async () => {
    // The map was module-scope, so two providers in one process answered each other's question about
    // which run a Bot is on, and the answer was whichever located last.
    const replicaA = createDockerSupervisorProvider({
      baseUrl: "http://supervisor-a:4300",
      fetchImpl: fakeSupervisor(() => FIRST_RUN, ["bot-e"]),
    });
    const replicaB = createDockerSupervisorProvider({
      baseUrl: "http://supervisor-b:4300",
      fetchImpl: fakeSupervisor(() => SECOND_RUN, ["bot-e"]),
    });

    await replicaA.locate("bot-e");
    expect(await replicaA.sessionOf?.("bot-e")).toBe(FIRST_RUN);
    expect(await replicaB.sessionOf?.("bot-e")).toBe(SECOND_RUN);
  });

  test("CONTROL: a ref from the run that is still current still resolves", async () => {
    // The same path with nothing replaced. A guard that refuses everything is not a guard, and this
    // is what says the refusals above are about the run and not about the ordering itself.
    const { gateway, rows } = stack(() => FIRST_RUN);

    const taken = await gateway.snapshot("bot-f");
    const clicked = await gateway.click("bot-f", ACTOR, {
      ref: "e9",
      snapshotId: taken.snapshotId,
    });

    expect(clicked).toMatchObject({
      action: "click",
      element: { role: "button", name: "Submit order" },
    });
    expect(rows.at(-1)?.payload.element).toMatchObject({
      name: "Submit order",
    });
  });
});
