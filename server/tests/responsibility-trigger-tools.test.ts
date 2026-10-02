import { afterEach, expect, test } from "bun:test";
import { callTool } from "../src/plugins/builtin-routines";
import { catalogueEntry, classifyTool } from "../src/plugins/catalogue";
import { createSlackTriggerIngest } from "../src/responsibilities/slack";
import { useTriggerTools } from "../src/responsibilities/trigger-tools";
import {
  parseTriggerConfig,
  type SlackAccess,
  slackAccessAllows,
} from "../src/responsibilities/triggers";
import {
  type ResponsibilityEvent,
  ResponsibilityNotFoundError,
} from "../src/responsibilities/types";

const CONNECTION = {
  url: "builtin://routines/",
  actorId: "owner-1",
  botId: "bot-1",
};
const TRIGGER_ID = "5b0f5a36-8f3e-4b0e-9f53-0a4c1d1e2f30";

function install() {
  const calls: unknown[][] = [];
  const record = {
    id: TRIGGER_ID,
    responsibilityId: "goal-1",
    kind: "webhook" as const,
    config: parseTriggerConfig({ kind: "webhook" }),
    hasSecret: true,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  useTriggerTools({
    publicUrl: "https://openbot.example.test",
    emailDomain: null,
    responsibilities: {
      async get(owner, id) {
        calls.push(["get", owner, id]);
        if (owner !== "owner-1" || id !== "goal-1")
          throw new ResponsibilityNotFoundError();
        return { id, agentId: "bot-1", title: "Triage" } as never;
      },
    },
    triggers: {
      async create(owner, responsibilityId, input) {
        calls.push(["create", owner, responsibilityId, input]);
        return { trigger: record, secret: "whsec_SHOULD_NEVER_BE_SHOWN" };
      },
      async listForAgent(owner, agentId) {
        calls.push(["listForAgent", owner, agentId]);
        return owner === "owner-1" && agentId === "bot-1"
          ? [{ ...record, title: "Triage" }]
          : [];
      },
      async setEnabled(owner, id, enabled) {
        calls.push(["setEnabled", owner, id, enabled]);
        return { ...record, enabled };
      },
      async remove(owner, id) {
        calls.push(["remove", owner, id]);
      },
    },
  });
  return calls;
}
afterEach(() => useTriggerTools(null));

test("create_trigger is attributed to the connection and never echoes the key", async () => {
  const calls = install();
  const result = await callTool(CONNECTION, "create_trigger", {
    responsibilityId: "goal-1",
    kind: "webhook",
    eventTypes: ["deploy"],
    ownerUserId: "attacker",
    secret: "pasted-in-chat",
  });
  expect(result.isError).toBe(false);
  expect(result.text).not.toContain("whsec_");
  expect(result.text).not.toContain("pasted-in-chat");
  expect(result.text).toContain(
    `https://openbot.example.test/api/events/triggers/${TRIGGER_ID}`,
  );
  expect(result.text).toContain("Responsibilities page");
  expect(calls.find((call) => call[0] === "create")).toEqual([
    "create",
    "owner-1",
    "goal-1",
    {
      config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
    },
  ]);
});

test("a Bot cannot manage triggers on another person's or another Bot's responsibility", async () => {
  install();
  const foreign = await callTool(
    { ...CONNECTION, botId: "bot-2" },
    "create_trigger",
    { responsibilityId: "goal-1", kind: "webhook" },
  );
  expect(foreign.isError).toBe(true);
  const other = await callTool(
    { ...CONNECTION, actorId: "owner-2" },
    "delete_trigger",
    { id: TRIGGER_ID },
  );
  expect(other.isError).toBe(true);
});

test("list, pause, resume and delete act only on the Bot's own triggers", async () => {
  const calls = install();
  const listed = await callTool(CONNECTION, "list_triggers", {});
  expect(listed.text).toContain(TRIGGER_ID);
  expect(listed.text).not.toContain("whsec_");
  await callTool(CONNECTION, "pause_trigger", { id: TRIGGER_ID });
  await callTool(CONNECTION, "resume_trigger", { id: TRIGGER_ID });
  await callTool(CONNECTION, "delete_trigger", { id: TRIGGER_ID });
  expect(calls.filter((call) => call[0] !== "listForAgent")).toEqual([
    ["setEnabled", "owner-1", TRIGGER_ID, false],
    ["setEnabled", "owner-1", TRIGGER_ID, true],
    ["remove", "owner-1", TRIGGER_ID],
  ]);
});

test("every routine and trigger mutation is a write, so the approvals gate sees it", () => {
  const entry = catalogueEntry("routines");
  for (const name of [
    "create_routine",
    "update_routine",
    "delete_routine",
    "create_trigger",
    "pause_trigger",
    "resume_trigger",
    "delete_trigger",
  ])
    expect(classifyTool(entry, name, true, null)).toBe("write");
  expect(classifyTool(entry, "list_triggers", true, null)).toBe("read");
});

const access = (
  identity: string | null,
  member: ((channel: string) => boolean) | null,
): SlackAccess => ({
  linkedIdentity: async () => identity,
  isMember: member ? async ({ channelId }) => member(channelId) : null,
});

test("Slack triggers need the owner's linked identity and membership of each channel", async () => {
  expect(await slackAccessAllows(undefined, "o", "T1", [])).toContain(
    "not connected",
  );
  expect(
    await slackAccessAllows(
      access(null, () => true),
      "o",
      "T1",
      [],
    ),
  ).toContain("Link your own Slack account");
  expect(await slackAccessAllows(access("U1", null), "o", "T1", [])).toContain(
    "cannot be checked",
  );
  expect(
    await slackAccessAllows(
      access("U1", (c) => c === "C1"),
      "o",
      "T1",
      ["C1", "C2"],
    ),
  ).toContain("C2");
  expect(
    await slackAccessAllows(
      access("U1", (c) => c === "C1"),
      "o",
      "T1",
      ["C1"],
    ),
  ).toBeNull();
});

test("each Slack event is re-checked against the owner's channel membership (fail closed)", async () => {
  const events: ResponsibilityEvent[] = [];
  const now = Math.floor(Date.now() / 1000);
  const trigger = {
    id: TRIGGER_ID,
    ownerUserId: "owner-1",
    responsibilityId: "goal-1",
    responsibilityStatus: "active" as const,
    kind: "slack" as const,
    config: parseTriggerConfig({
      kind: "slack",
      teamId: "T1",
      mode: "message",
    }),
    secret: null,
    enabled: true,
    createdAt: new Date((now - 60) * 1000),
    agentId: "bot-1",
  };
  const ingest = createSlackTriggerIngest({
    directory: {
      resolve: async () => null,
      slackTriggers: async () => [trigger],
    },
    ingest: async (event) => {
      events.push(event);
      return { eventId: "e", duplicate: false, runIds: ["r"] };
    },
    slackAccess: () => access("U1", (channel) => channel === "C1"),
  });
  const event = {
    teamId: "T1",
    eventId: "Ev1",
    eventTime: now,
    type: "message" as const,
    channelId: "C1",
    userId: "U9",
    ts: `${now}.000100`,
    text: "hello",
  };
  expect((await ingest(event)).matched).toBe(1);
  const outside = await ingest({ ...event, eventId: "Ev2", channelId: "C2" });
  expect(outside.matched).toBe(0);
  expect(outside.deliveries[0]?.outcome).toMatchObject({ status: "ignored" });
  expect(events).toHaveLength(1);
});
