import { describe, expect, test } from "bun:test";
import { describeEvent, eventDetail } from "@/lib/routines/events";
import { goalStarts } from "@/lib/routines/merged";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";

describe("an event a goal listens for, in words", () => {
  test.each([
    ["github", "check_run.completed", "When a GitHub check finishes"],
    ["github", "issues.opened", "When a GitHub issue opens"],
    ["github", "pull_request.opened", "When a GitHub pull request opens"],
    ["github", "push", "When someone pushes to GitHub"],
    ["slack", "app_mention", "When someone mentions the Bot in Slack"],
    ["linear", "Issue.create", "When a Linear issue is created"],
    ["sentry", "issue.created", "When Sentry finds a new issue"],
    ["pagerduty", "incident.triggered", "When a PagerDuty incident starts"],
    ["email", "received", "When an email arrives"],
  ] as const)("%s %s reads “%s”", (source, eventType, words) => {
    expect(describeEvent({ source, eventType })).toBe(words);
  });

  test("an event it doesn't know says which source, never the identifier or a guess", () => {
    const said = describeEvent({
      source: "github",
      eventType: "deployment_status",
    });
    expect(said).toBe("When a GitHub event arrives");
    expect(said).not.toContain("deployment");
  });

  test("an unknown event from a source starting with a vowel reads naturally", () => {
    expect(describeEvent({ source: "email", eventType: "bounced" })).toBe(
      "When an Email event arrives",
    );
  });

  test("every event from a source says so", () => {
    expect(describeEvent({ source: "github", eventType: "*" })).toBe(
      "When any GitHub event arrives",
    );
  });

  test("a finished check is not called a passing one", () => {
    expect(
      describeEvent({ source: "github", eventType: "check_run.completed" }),
    ).not.toMatch(/pass|succeed|fail/i);
  });

  test("the details keep the exact identifier beside the words", () => {
    expect(eventDetail({ source: "github", eventType: "issues.opened" })).toBe(
      "When a GitHub issue opens (GitHub issues.opened)",
    );
    expect(
      eventDetail({ source: "github", eventType: "deployment_status" }),
    ).toBe("When a GitHub event arrives (GitHub deployment_status)");
  });
});

const goal = (
  subscriptions: ResponsibilityRecord["subscriptions"],
): ResponsibilityRecord => ({
  id: "g1",
  agentId: "bot",
  channelId: "c1",
  threadId: "t1",
  title: "Watch CI",
  instruction: "Tell me.",
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions,
  endsWhenMet: false,
  updatedAt: "2026-11-10T10:00:00Z",
});

const schedule = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  agentId: "bot",
  schedule: "Weekdays at 09:00",
  timezone: "Europe/Madrid",
  instruction: "Check.",
  title: null,
  channel: { id: "c1", name: null, title: "CI", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: "g1",
  ...overrides,
});

describe("a goal's starts on the Routines list", () => {
  test("several events read as words, with the schedule's wording unchanged", () => {
    const starts = goalStarts(
      goal([
        { source: "github", eventType: "check_run.completed" },
        { source: "github", eventType: "issues.opened" },
      ]),
      [],
      [schedule()],
      describeEvent,
    );
    expect(starts).toBe(
      "Weekdays at 09:00, When a GitHub check finishes, When a GitHub issue opens",
    );
    expect(starts).not.toContain("check_run.completed");
    expect(starts).not.toContain("issues.opened");
  });
});
