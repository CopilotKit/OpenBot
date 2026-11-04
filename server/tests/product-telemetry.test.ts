import { expect, test } from "bun:test";
import { observedProductRun } from "../scripts/support/product-run";
import {
  parseConsumption,
  productExportEnabled,
  projectAuditMilestone,
  scopedProductUser,
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

async function adapter(
  env: Record<string, string | undefined> = { OPENBOT_PRODUCT_TELEMETRY: "1" },
) {
  const sent: LambdaSendOptions[] = [];
  const telemetry = await createProductTelemetry({
    privacyKey: "synthetic-key",
    deploymentId: "deployment-one",
    env,
    send: async (event) => {
      sent.push(event);
    },
  });
  return { sent, telemetry };
}
test("source success emits linkage without local first-use or dedupe state", async () => {
  const f = await adapter();
  await observedProductRun(f.telemetry);
  await observedProductRun(f.telemetry);
  const terminal = f.sent.filter((e) => e.event.endsWith("run_terminal"));
  expect(terminal).toHaveLength(2);
  expect(terminal[0]?.properties).toMatchObject({
    outcome: "success",
    is_root: true,
    result_message_ids: ["message-run-one"],
  });
  expect(terminal[0]?.properties?.event_id).toBe(
    terminal[1]?.properties?.event_id,
  );
  expect(f.sent.some((e) => e.event.endsWith("first_human_success"))).toBe(
    false,
  );
  expect(JSON.stringify(f.sent)).not.toContain("private-user-one");
});
test("cancellation, interruption and missing terminals never fabricate success; child remains separate", async () => {
  const f = await adapter();
  await observedProductRun(f.telemetry, {
    run: "cancelled",
    events: [
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-one",
        runId: "cancelled",
        outcome: { type: "cancelled" },
      },
    ],
  });
  await observedProductRun(f.telemetry, {
    run: "interrupted",
    events: [
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-one",
        runId: "interrupted",
        outcome: { type: "interrupt", interrupts: [] },
      },
    ],
  });
  await observedProductRun(f.telemetry, {
    run: "missing",
    events: [
      { type: EventType.RUN_STARTED, threadId: "thread-one", runId: "missing" },
    ],
  });
  await observedProductRun(f.telemetry, {
    run: "child",
    parent: "root",
    trigger: "subagent",
    events: [{ type: EventType.RUN_ERROR, message: "private-error" }],
  });
  const terminal = f.sent
    .filter((e) => e.event.endsWith("run_terminal"))
    .map((e) => e.properties);
  expect(terminal.map((p) => p?.outcome)).toEqual([
    "cancelled",
    "unknown",
    "unknown",
    "error",
  ]);
  expect(terminal[3]).toMatchObject({
    parent_run_id: "root",
    root_task_id: null,
    is_root: false,
  });
  expect(JSON.stringify(f.sent)).not.toContain("private-error");
});
test("opt-out prevents preparation, audit collection, and sending", async () => {
  const f = await adapter({
    OPENBOT_PRODUCT_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  });
  await observedProductRun(f.telemetry);
  await f.telemetry.recordAudit({
    id: "audit",
    eventType: "bot.created",
    actorUserId: "private",
    targetType: "bot",
    initiatorKind: "person",
    initiatorId: null,
    payload: {},
  });
  expect(f.sent).toHaveLength(0);
  expect(
    await f.telemetry.prepare({
      actorUserId: "private",
      threadId: "thread",
      runId: "run",
      trigger: "human",
      surface: "web",
    }),
  ).toBeUndefined();
});
test("existing audit IDs produce stable allowlisted events without customer content", async () => {
  const f = await adapter();
  const event = {
    id: "audit-existing",
    eventType: "mcp.account_connected",
    targetType: "mcp_server",
    initiatorKind: "person" as const,
    initiatorId: null,
    payload: {
      actor: "private-user",
      server: "private-server",
      scope: "private-scope",
    },
  };
  await f.telemetry.recordAudit(event);
  await f.telemetry.recordAudit(event);
  expect(f.sent[0]?.properties?.user_id).toBe(
    scopedProductUser("synthetic-key", "deployment-one", "private-user"),
  );
  expect(f.sent[0]?.properties?.event_id).toBe(f.sent[1]?.properties?.event_id);
  expect(JSON.stringify(f.sent)).not.toContain("private-");
});
test("consumption forwards bounded references without claiming execution success", async () => {
  const f = await adapter();
  const event = {
    kind: "result_viewed" as const,
    threadId: "thread",
    messageId: "message",
    surface: "web" as const,
  };
  await f.telemetry.consume("actor", event);
  await f.telemetry.consume("actor", event);
  expect(f.sent[0]?.properties?.event_id).toBe(f.sent[1]?.properties?.event_id);
  expect(f.sent[0]?.properties).toMatchObject({
    thread_id: "thread",
    message_id: "message",
    consumption_surface: "web",
  });
  expect(f.sent[0]?.properties).not.toHaveProperty("outcome");
});
test("transport failures are observed and do not reject product flows", async () => {
  const warnings: string[] = [];
  const telemetry = await createProductTelemetry({
    privacyKey: "synthetic",
    env: { OPENBOT_PRODUCT_TELEMETRY: "1" },
    warn: (r) => warnings.push(r),
    send: async () => {
      throw Error("private transport failure");
    },
  });
  await observedProductRun(telemetry);
  expect(warnings).toEqual(["send_failed"]);
});
test("adapter has no database, persistence, signing or outbox dependency", async () => {
  const source = await Bun.file(
    new URL("../src/telemetry/product.ts", import.meta.url),
  ).text();
  for (const forbidden of [
    "ProductStore",
    "enterpriseSettings",
    "../db/",
    "randomBytes",
    "timingSafeEqual",
    "first_human_success",
  ])
    expect(source).not.toContain(forbidden);
});
