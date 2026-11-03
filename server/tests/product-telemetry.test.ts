import { observedProductRun } from "../scripts/support/product-run";
import { expect, test } from "bun:test";
import {
  productExportEnabled,
  scopedProductUser,
  projectAuditMilestone,
  parseConsumption,
} from "../src/telemetry/product";

test("self-host product export requires consent and every distribution honors opt-out", () => {
  expect(productExportEnabled({})).toBe(false);
  expect(productExportEnabled({ OPENBOT_DISTRIBUTION: "desktop" })).toBe(true);
  expect(productExportEnabled({ OPENBOT_PRODUCT_TELEMETRY: "1" })).toBe(true);
  expect(
    productExportEnabled({
      OPENBOT_DISTRIBUTION: "desktop",
      OPENBOT_PRODUCT_TELEMETRY: "0",
    }),
  ).toBe(false);
  expect(
    productExportEnabled({ OPENBOT_PRODUCT_TELEMETRY: "1", DO_NOT_TRACK: "1" }),
  ).toBe(false);
});

test("pseudonyms are stable, deployment scoped, and never raw users", () => {
  const one = scopedProductUser(
    "salt-one",
    "deployment-one",
    "private@example.test",
  );
  expect(one).toBe(
    scopedProductUser("salt-one", "deployment-one", "private@example.test"),
  );
  expect(one).not.toBe(
    scopedProductUser("salt-one", "deployment-two", "private@example.test"),
  );
  expect(one).not.toBe(
    scopedProductUser("salt-one", "deployment-one", "another-user"),
  );
  expect(one).not.toContain("private");
});

test("audit export projects closed categories only and discards raw content", () => {
  expect(
    projectAuditMilestone({
      eventType: "mcp.call_succeeded",
      payload: {
        arguments: "private",
        result: "private",
        url: "https://private",
      },
    }),
  ).toEqual({
    capability: "connection",
    stage: "use",
    outcome: "completed",
    actor_kind: "automation",
  });
  expect(
    projectAuditMilestone({
      eventType: "mcp.authorization_cancelled",
      payload: {},
    })?.outcome,
  ).toBe("cancelled");
  expect(
    projectAuditMilestone({
      eventType: "approval.person_decided",
      payload: { decision: "deny" },
    })?.capability,
  ).toBe("approval");
  expect(
    projectAuditMilestone({ eventType: "not.allowlisted", payload: {} }),
  ).toBeNull();
});

test.each([
  {
    label: "verified",
    payload: { verified: true, action: "private-probe" },
    outcome: "completed",
  },
  {
    label: "observed failed check",
    payload: { verified: false, action: "private-probe" },
    outcome: "failed",
  },
  {
    label: "unchecked connection",
    payload: { verified: false, action: null },
    outcome: "attempted",
  },
  {
    label: "unreachable check",
    payload: { verified: false, action: null, unreachable: "private-failure" },
    outcome: "attempted",
  },
  {
    label: "missing verification evidence",
    payload: { action: "private-probe" },
    outcome: "attempted",
  },
] as const)(
  "connection verification projects $label without exporting probe details",
  ({ payload, outcome }) => {
    expect(
      projectAuditMilestone({ eventType: "mcp.connection_verified", payload }),
    ).toEqual({
      capability: "connection",
      stage: "setup",
      outcome,
      actor_kind: "human",
    });
  },
);

test("consumption accepts existing actions and refuses identity/content injection", () => {
  const valid = {
    kind: "result_viewed",
    threadId: "thread",
    messageId: "message",
    surface: "web",
  } as const;
  expect(parseConsumption(valid)).toEqual(valid);
  expect(parseConsumption({ ...valid, userId: "forged" })).toBeNull();
  expect(parseConsumption({ ...valid, messageId: "x".repeat(257) })).toBeNull();
  expect(
    parseConsumption({ ...valid, kind: "notification_opened" }),
  ).toBeNull();
});

import { EventType } from "@ag-ui/client";
import type { LambdaSendOptions } from "@copilotkit/shared";
import { createProductTelemetry } from "../src/telemetry/product";
import { productStoreFixture } from "../scripts/support/product-store";

async function adapter(
  fixture = productStoreFixture(),
  env: Record<string, string | undefined> = { OPENBOT_PRODUCT_TELEMETRY: "1" },
) {
  const sent: LambdaSendOptions[] = [];
  const warnings: string[] = [];
  const telemetry = await createProductTelemetry({
    store: fixture.store,
    env,
    send: async (event) => {
      sent.push(event);
    },
    warn: (reason) => warnings.push(reason),
  });
  return { ...fixture, sent, warnings, telemetry };
}
async function observedRun(
  f: Awaited<ReturnType<typeof adapter>>,
  options: Parameters<typeof observedProductRun>[1] = {},
) {
  return observedProductRun(f.telemetry, options);
}

test("an observed success stores exact result linkage and first human success once across restarts", async () => {
  const f = await adapter();
  await observedRun(f);
  expect(f.runs.get("run-one")?.outcome).toBe("success");
  expect(
    await f.telemetry.consume("private-user-two", {
      kind: "result_viewed",
      threadId: "thread-one",
      messageId: "message-run-one",
      surface: "web",
    }),
  ).toBe("pending");
  const restarted = await adapter(f);
  await observedRun(restarted, { run: "run-two" });
  expect(
    [...f.events.values()].filter((e) =>
      e.name.endsWith("first_human_success"),
    ),
  ).toHaveLength(1);
  await f.telemetry.consume("private-user-one", {
    kind: "result_viewed",
    threadId: "thread-one",
    messageId: "message-run-one",
    surface: "web",
  });
  await restarted.telemetry.consume("private-user-one", {
    kind: "result_viewed",
    threadId: "thread-one",
    messageId: "message-run-one",
    surface: "web",
  });
  expect(
    [...f.events.values()].filter((e) => e.name.endsWith("result_viewed")),
  ).toHaveLength(1);
  expect(JSON.stringify(f.sent)).not.toContain("private-user-one");
});

test("cancelled and interrupted finish outcomes never become success", async () => {
  const f = await adapter();
  await observedRun(f, {
    events: [
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-one",
        runId: "run-one",
        outcome: { type: "cancelled" },
      },
    ],
  });
  expect(f.runs.get("run-one")?.outcome).toBe("cancelled");
  await observedRun(f, {
    run: "interrupt",
    events: [
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-one",
        runId: "interrupt",
        outcome: { type: "interrupt", interrupts: [] },
      },
    ],
  });
  expect(f.runs.get("interrupt")?.outcome).toBe("unknown");
  expect(
    [...f.events.values()].filter((e) =>
      e.name.endsWith("first_human_success"),
    ),
  ).toHaveLength(0);
});

test("completion without a terminal is unknown, child failure never overwrites root, retries retain lineage", async () => {
  const f = await adapter();
  await observedRun(f, { run: "root" });
  await observedRun(f, {
    run: "child",
    parent: "root",
    trigger: "subagent",
    events: [{ type: EventType.RUN_ERROR, message: "private error" }],
  });
  await observedRun(f, {
    run: "retry",
    root: "root-one",
    attempt: 2,
    events: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.runs.get("root")?.outcome).toBe("success");
  expect(f.runs.get("child")?.outcome).toBe("error");
  expect(f.runs.get("child")?.context.parent_run_id).toBe("root");
  expect(f.runs.get("child")?.context.root_task_id).toBe(
    f.runs.get("root")?.context.root_task_id,
  );
  expect(f.runs.get("retry")?.outcome).toBe("unknown");
  expect(f.runs.get("retry")?.context.attempt).toBe(2);
  expect(JSON.stringify(f.sent)).not.toContain("private error");
});

test("opt-out avoids identity, run ledger, audit collection and sends", async () => {
  const f = await adapter(productStoreFixture(), {
    OPENBOT_PRODUCT_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  });
  await observedRun(f);
  f.telemetry.recordAudit({
    id: "audit",
    eventType: "bot.created",
    actorUserId: "private",
    targetType: "bot",
    initiatorKind: "person",
    initiatorId: null,
    payload: {},
  });
  expect(f.runs.size).toBe(0);
  expect(f.events.size).toBe(0);
  expect(f.sent).toHaveLength(0);
});

test("nested child lifecycle events cannot terminate the root observer", async () => {
  const f = await adapter();
  await observedRun(f, {
    events: [
      {
        type: EventType.SUBAGENT_ERROR,
        message: "child failed",
        subagentRunId: "remote-child",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-one",
        runId: "run-one",
        outcome: { type: "success" },
      },
    ],
  });
  expect(f.runs.get("run-one")?.outcome).toBe("success");
});

test("actual policy outcome objects preserve rejection and permission requests", () => {
  expect(
    projectAuditMilestone({
      eventType: "approval.evaluated",
      payload: { outcome: { behaviour: "deny", source: "default" } },
    })?.outcome,
  ).toBe("rejected");
  expect(
    projectAuditMilestone({
      eventType: "approval.evaluated",
      payload: { outcome: { behaviour: "ask", source: "default" } },
    })?.outcome,
  ).toBe("requested");
});

test("existing connector audit actors are scoped even when the actor is in its trusted payload", async () => {
  const f = await adapter();
  await f.telemetry.recordAudit({
    id: "persisted-connector-event",
    eventType: "mcp.account_connected",
    targetType: "mcp_server",
    initiatorKind: "person",
    initiatorId: null,
    payload: {
      actor: "private-connector-user",
      server: "private-app",
      scope: "private-scope",
    },
  });
  await f.telemetry.flush();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.properties?.user_id).toBe(
    scopedProductUser(
      "synthetic-salt",
      "deployment-one",
      "private-connector-user",
    ),
  );
  expect(JSON.stringify(f.sent)).not.toContain("private-");
});

test("failed transport attempts remain replayable with identical producer IDs", async () => {
  const f = productStoreFixture();
  const sentBefore: string[] = [];
  const failed = await createProductTelemetry({
    store: f.store,
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    send: async (event) => {
      sentBefore.push(String(event.properties?.event_id));
      throw new Error("synthetic transport unavailable");
    },
    warn: () => {},
  });
  await observedProductRun(failed);
  expect(f.attempted.size).toBe(0);
  const sentAfter: string[] = [];
  const restarted = await createProductTelemetry({
    store: f.store,
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    send: async (event) => {
      sentAfter.push(String(event.properties?.event_id));
    },
  });
  await restarted.start();
  await restarted.flush();
  expect(sentAfter.sort()).toEqual(sentBefore.sort());
  expect(f.attempted.size).toBe(3);
});

test("a bounded queue drops excess telemetry without failing the product operation", async () => {
  const f = productStoreFixture();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const telemetry = await createProductTelemetry({
    store: f.store,
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    maxQueue: 1,
    send: async () => blocked,
    warn: () => {},
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      telemetry.recordAudit({
        id: `audit-${index}`,
        eventType: "bot.created",
        actorUserId: "synthetic",
        targetType: "bot",
        initiatorKind: "person",
        initiatorId: null,
        payload: {},
      }),
    ),
  );
  expect(telemetry.health().dropped).toBeGreaterThan(0);
  expect(telemetry.health().queued).toBeLessThanOrEqual(1);
  release();
  await telemetry.flush();
});

test("identity persistence failure disables richer collection instead of inventing continuity", async () => {
  const f = productStoreFixture();
  const warnings: string[] = [];
  const telemetry = await createProductTelemetry({
    store: {
      ...f.store,
      identity: async () => {
        throw new Error("private DB failure");
      },
    },
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    warn: (reason) => warnings.push(reason),
  });
  expect(telemetry.enabled()).toBe(false);
  expect(warnings).toEqual(["identity_unavailable"]);
  expect(
    await telemetry.prepare({
      actorUserId: "synthetic",
      threadId: "thread",
      runId: "run",
      trigger: "human",
      surface: "web",
    }),
  ).toBeUndefined();
});
