import { expect, test } from "bun:test";
import {
  accessSummary,
  countLabel,
  memorySummary,
  reachSummary,
  setupSummary,
  sharingSummary,
} from "@/lib/agents/bot-summaries";

test("counts read as words", () => {
  expect(countLabel(0, "routine", "routines", "No routines")).toBe(
    "No routines",
  );
  expect(countLabel(1, "routine", "routines", "No routines")).toBe("1 routine");
  expect(countLabel(3, "routine", "routines", "No routines")).toBe(
    "3 routines",
  );
});

test("access names skills and apps, or says there is nothing", () => {
  expect(accessSummary(0, 0)).toBe("Nothing granted");
  expect(accessSummary(2, 0)).toBe("2 skills");
  expect(accessSummary(0, 1)).toBe("1 app");
  expect(accessSummary(1, 3)).toBe("1 skill, 3 apps");
});

test("sharing names the audience", () => {
  expect(sharingSummary(undefined, "private")).toBe("Not shared");
  expect(sharingSummary({ audience: "team" }, "private")).toBe("Whole team");
  expect(sharingSummary({ audience: "people" }, "private")).toBe(
    "Specific people and groups",
  );
});

test("setup names where it runs", () => {
  expect(
    setupSummary({ builtIn: true, endpoint: "http://localhost:4201/ag-ui" }),
  ).toBe("Built in");
  expect(
    setupSummary({
      builtIn: false,
      endpoint: "https://bots.example.com/ag-ui",
    }),
  ).toBe("bots.example.com");
  expect(setupSummary({ builtIn: false, endpoint: "not a url" })).toBe(
    "not a url",
  );
  expect(setupSummary({ builtIn: false, endpoint: null })).toBe("Built in");
});

test("a public Bot nobody published is still open to everyone, not 'Not shared'", () => {
  expect(sharingSummary(undefined, "public")).toBe("Everyone (public)");
});

test("reach names the places a Bot continues the conversation", () => {
  expect(reachSummary([])).toBe("Only in OpenBot");
  expect(reachSummary(["slack"])).toBe("Slack");
  expect(reachSummary(["sms", "slack", "slack"])).toBe("Slack, SMS");
  expect(reachSummary(["teams"])).toBe("Microsoft Teams");
});

test("memory names the sources and whether research is on", () => {
  expect(memorySummary(0, false)).toBe("Nothing connected");
  expect(memorySummary(2, false)).toBe("2 sources");
  expect(memorySummary(0, true)).toBe("Background research on");
  expect(memorySummary(1, true)).toBe("1 source, background research on");
});
