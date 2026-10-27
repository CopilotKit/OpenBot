import { describe, expect, test } from "bun:test";
import type { ApprovalInboxData } from "@/lib/approvals";
import type { ProactiveSuggestion } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import {
  conversationPath,
  isSkinScreen,
  tabForPath,
} from "@/skins/openduet/places";
import {
  actionName,
  tasksModel,
  waitingCount,
} from "@/skins/openduet/tasks-model";

/*
 * The rules OpenDuet's frame and Tasks run on, against the shapes OpenBot's own endpoints return.
 * Which paths are tabs decides whether a screen has a tab bar or a back disc; which rows Tasks keeps
 * decides whether a decided approval or a paused responsibility is shown as waiting.
 */

describe("which tab a path is", () => {
  test("every conversation OpenBot draws is Chat", () => {
    for (const path of [
      "/",
      "/channel/new",
      "/channel/c-1",
      "/group/g-1",
      "/group/new",
      "/bot",
      "/channel/c-1/",
    ])
      expect(tabForPath(path)).toBe("chat");
  });

  test("the skin's Tasks screen is Tasks", () => {
    expect(tabForPath("/s/tasks")).toBe("tasks");
    expect(isSkinScreen("/s/tasks")).toBe(true);
  });

  test("every other page opens over the app, with no tab", () => {
    for (const path of [
      "/bots",
      "/bots/b-1",
      "/bots/b-1/responsibilities",
      "/routines",
      "/capabilities/skills",
      "/capabilities/memory",
      "/connections",
      "/channel/c-1/extra",
    ]) {
      expect(tabForPath(path)).toBeNull();
      expect(isSkinScreen(path)).toBe(false);
    }
  });

  test("a conversation with several Bots opens as a group", () => {
    expect(conversationPath({ id: "c", agentIds: ["a"] })).toBe("/channel/c");
    expect(conversationPath({ id: "g", agentIds: ["a", "b"] })).toBe(
      "/group/g",
    );
  });
});

const request = (
  id: string,
  status: string,
  toolRef = "mcp/gmail/send_email",
  createdAt = "2026-10-27T10:00:00.000Z",
): ApprovalInboxData["requests"][number] => ({
  id,
  status,
  createdAt,
  action: {
    botId: "b-1",
    toolRef,
    effect: "write",
    scope: "priya@example.com",
    threadId: "t-1",
    args: { to: "priya@example.com" },
    target: null,
  },
});

const inbox = (
  requests: ApprovalInboxData["requests"],
  questions: ApprovalInboxData["questions"] = [],
): ApprovalInboxData => ({
  enabled: true,
  requests,
  rules: [],
  teamRules: [],
  questions,
});

const responsibility = (
  id: string,
  status: ResponsibilityRecord["status"],
  title = `Responsibility ${id}`,
): ResponsibilityRecord => ({
  id,
  agentId: "b-1",
  channelId: "c-1",
  threadId: "t-1",
  title,
  instruction: "Keep the inbox at zero",
  successCriteria: "",
  status,
  progress: "",
  lastResult: null,
  subscriptions: [],
  updatedAt: "2026-10-27T09:00:00.000Z",
});

const routine = (
  id: string,
  enabled: boolean,
  nextRunAt: string,
): RoutineRecord => ({
  id,
  agentId: "b-1",
  schedule: "Every weekday at 9:00",
  timezone: "UTC",
  instruction: `Routine ${id}`,
  channel: { id: "c-1", name: "Standup", gone: false },
  enabled,
  nextRunAt,
  lastRun: null,
});

const suggestion = (id: string, createdAt: string): ProactiveSuggestion => ({
  id,
  agentId: "b-1",
  title: `Suggestion ${id}`,
  detail: "",
  sourceApp: null,
  sourceLink: null,
  createdAt,
});

describe("what Tasks shows from OpenBot's data", () => {
  test("only pending approvals wait on the person; a decided one has gone its way", () => {
    const model = tasksModel({
      inbox: inbox([
        request("waiting", "pending"),
        request("allowed", "allowed"),
        request("denied", "denied"),
      ]),
      responsibilities: [],
      routines: [],
      suggestions: [],
    });
    expect(model.requests.map((row) => row.id)).toEqual(["waiting"]);
  });

  test("the Tasks badge counts pending approvals and questions, as Needs input lists them", () => {
    const data = inbox(
      [request("a", "pending"), request("b", "allowed")],
      [
        {
          id: "q",
          botId: "b-1",
          threadId: "t-1",
          question: "Which account?",
          createdAt: "2026-10-27T10:00:00.000Z",
        },
      ],
    );
    expect(waitingCount(data)).toBe(2);
    expect(waitingCount(undefined)).toBe(0);
    const model = tasksModel({
      inbox: data,
      responsibilities: [],
      routines: [],
      suggestions: [],
    });
    expect(model.requests.length + model.questions.length).toBe(
      waitingCount(data),
    );
  });

  test("only responsibilities under way are active; paused and completed are not", () => {
    const model = tasksModel({
      inbox: undefined,
      responsibilities: [
        responsibility("on", "active"),
        responsibility("paused", "paused"),
        responsibility("done", "completed"),
      ],
      routines: [],
      suggestions: [],
    });
    expect(model.responsibilities.map((row) => row.id)).toEqual(["on"]);
  });

  test("only switched-on routines are active, the one firing soonest first", () => {
    const model = tasksModel({
      inbox: undefined,
      responsibilities: [],
      routines: [
        routine("later", true, "2026-10-29T09:00:00.000Z"),
        routine("off", false, "2026-10-28T09:00:00.000Z"),
        routine("soon", true, "2026-10-28T09:00:00.000Z"),
      ],
      suggestions: [],
    });
    expect(model.routines.map((row) => row.id)).toEqual(["soon", "later"]);
  });

  test("Up next is every open suggestion, newest first unless asked otherwise", () => {
    const suggestions = [
      suggestion("old", "2026-10-26T09:00:00.000Z"),
      suggestion("new", "2026-10-27T09:00:00.000Z"),
    ];
    const base = {
      inbox: undefined,
      responsibilities: [],
      routines: [],
      suggestions,
    };
    expect(tasksModel(base).suggestions.map((row) => row.id)).toEqual([
      "new",
      "old",
    ]);
    expect(
      tasksModel({ ...base, order: "oldest" }).suggestions.map((row) => row.id),
    ).toEqual(["old", "new"]);
  });

  test("search narrows every section by what it says, ignoring case", () => {
    const model = tasksModel({
      inbox: inbox([
        request("mail", "pending"),
        request("shell", "pending", "host/run_command"),
      ]),
      responsibilities: [
        responsibility("r1", "active", "Triage the support inbox"),
        responsibility("r2", "active", "Watch the deploys"),
      ],
      routines: [],
      suggestions: [suggestion("s1", "2026-10-27T09:00:00.000Z")],
      query: "INBOX",
    });
    expect(model.responsibilities.map((row) => row.id)).toEqual(["r1"]);
    expect(model.requests).toEqual([]);
    expect(model.suggestions).toEqual([]);
  });

  test("a waiting action is named from its tool, without the app, host or computer before it", () => {
    expect(actionName("mcp/gmail/send_email")).toBe("send email");
    expect(actionName("computer_click")).toBe("click");
    expect(actionName("host/run_command")).toBe("run command");
    expect(actionName("bot/handoff")).toBe("handoff");
  });
});
