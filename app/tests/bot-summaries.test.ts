import { expect, test } from "bun:test";
import {
  accessSummary,
  countLabel,
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
  expect(sharingSummary(undefined)).toBe("Not shared");
  expect(sharingSummary({ audience: "team" })).toBe("Whole team");
  expect(sharingSummary({ audience: "people" })).toBe(
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
