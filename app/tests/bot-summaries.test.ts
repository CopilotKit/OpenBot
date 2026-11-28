import { expect, test } from "bun:test";
import {
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

test("sharing names the audience", () => {
  expect(sharingSummary(undefined, "private")).toBe("Not shared");
  // The wire's `team` is everybody: a person reads "organization", never "team", for it.
  expect(sharingSummary({ audience: "team" }, "private")).toBe(
    "Everyone in the organization",
  );
  expect(sharingSummary({ audience: "people" }, "private")).toBe(
    "Specific people and teams",
  );
});

test("setup names where a connected Bot runs, and says nothing for one that runs inside OpenBot", () => {
  expect(
    setupSummary({ builtIn: true, endpoint: "http://localhost:4201/ag-ui" }),
  ).toBe("");
  expect(
    setupSummary({
      builtIn: false,
      endpoint: "https://bots.example.com/ag-ui",
    }),
  ).toBe("bots.example.com");
  expect(setupSummary({ builtIn: false, endpoint: "not a url" })).toBe(
    "not a url",
  );
  expect(setupSummary({ builtIn: false, endpoint: null })).toBe("");
});

/*
 * The personal edition's starter runs on the harness its one person picked at setup, at the address
 * of the container OpenBot started for it ("agent-harness:4206" on Windows). That address means
 * nothing to them; the framework does. A team deployment still shows the address.
 */
test("the personal edition names what runs a Bot instead of its address", () => {
  const harness = {
    builtIn: false,
    endpoint: "http://agent-harness:4206/ag-ui",
    framework: "LangChain",
  };
  expect(setupSummary(harness, "personal")).toBe("Runs on LangChain");
  expect(setupSummary(harness, "team")).toBe("agent-harness:4206");
  expect(setupSummary(harness)).toBe("agent-harness:4206");
  // An agent connected by address with no framework named: the address is all there is.
  expect(
    setupSummary(
      { builtIn: false, endpoint: "http://127.0.0.1:8000/ag-ui" },
      "personal",
    ),
  ).toBe("127.0.0.1:8000");
  expect(
    setupSummary(
      { builtIn: true, endpoint: null, framework: "OpenBot" },
      "personal",
    ),
  ).toBe("");
});

test("a public Bot nobody published is open to everyone in the organization, not 'Not shared'", () => {
  expect(sharingSummary(undefined, "public")).toBe(
    "Everyone in the organization (public)",
  );
  expect(
    sharingSummary(undefined, "public", { organizationName: "Acme" }),
  ).toBe("Everyone in Acme (public)");
  // The organization's only member is told it's only them.
  expect(
    sharingSummary(undefined, "public", {
      organizationName: "Sam's organization",
      alone: true,
    }),
  ).toBe("Only you (public)");
});

test("reach names the places a Bot continues the conversation", () => {
  expect(reachSummary([])).toBe("Only in OpenBot");
  expect(reachSummary(["slack"])).toBe("Slack");
  expect(reachSummary(["sms", "slack", "slack"])).toBe("Slack, SMS");
  expect(reachSummary(["teams"])).toBe("Microsoft Teams");
});

test("memory names the sources, and leaves check-ins to Routines", () => {
  expect(memorySummary(0)).toBe("Nothing connected");
  expect(memorySummary(1)).toBe("1 source");
  expect(memorySummary(2)).toBe("2 sources");
});
