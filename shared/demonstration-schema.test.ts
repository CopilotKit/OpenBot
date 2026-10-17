import { expect, test } from "bun:test";
import {
  demonstrationActionSchema,
  hasTarget,
  NETWORK_STEP_METHODS,
} from "./demonstration-schema";

test("recorded actions reject typed secrets and unknown payload fields", () => {
  expect(
    demonstrationActionSchema.safeParse({
      kind: "type",
      url: "https://example.test/form",
      target: { role: "textbox", name: "Password", sensitive: true },
      text: "private-password",
    }).success,
  ).toBe(false);
});

test("a click with a target parses", () => {
  const parsed = demonstrationActionSchema.parse({
    kind: "click",
    url: "https://example.test/form",
    target: { role: "button", name: "Save", sensitive: false },
  });
  expect(hasTarget(parsed)).toBe(true);
});

test("a navigate step parses with its transition", () => {
  const parsed = demonstrationActionSchema.parse({
    kind: "navigate",
    url: "https://example.test/invoices",
    transition: "link",
  });
  expect(parsed.kind).toBe("navigate");
  expect(hasTarget(parsed)).toBe(false);
});

test("a navigate step with an unknown transition is rejected", () => {
  expect(
    demonstrationActionSchema.safeParse({
      kind: "navigate",
      url: "https://example.test/invoices",
      transition: "teleport",
    }).success,
  ).toBe(false);
});

test("a state-changing network step parses", () => {
  const parsed = demonstrationActionSchema.parse({
    kind: "network",
    url: "https://api.example.test/v1/deals",
    method: "POST",
    status: 201,
  });
  expect(parsed.kind).toBe("network");
  expect(hasTarget(parsed)).toBe(false);
});

test("a network step for a read is rejected, reads are not steps", () => {
  expect(
    demonstrationActionSchema.safeParse({
      kind: "network",
      url: "https://api.example.test/v1/deals",
      method: "GET",
      status: 200,
    }).success,
  ).toBe(false);
  expect([...NETWORK_STEP_METHODS]).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
});

test("a network step whose URL carries a query token is rejected", () => {
  expect(
    demonstrationActionSchema.safeParse({
      kind: "network",
      url: "https://api.example.test/v1/deals?token=x",
      method: "POST",
      status: 201,
    }).success,
  ).toBe(false);
});

test("a navigate step with a target field is rejected", () => {
  expect(
    demonstrationActionSchema.safeParse({
      kind: "navigate",
      url: "https://example.test/invoices",
      transition: "link",
      target: { role: "link", name: "Invoices", sensitive: false },
    }).success,
  ).toBe(false);
});

test("hasTarget is true for every gesture kind and false for navigate and network", () => {
  const target = { role: "textbox", name: "Search", sensitive: false };
  for (const kind of ["click", "type", "key", "scroll"] as const) {
    expect(
      hasTarget(
        demonstrationActionSchema.parse({
          kind,
          url: "https://example.test/",
          target,
        }),
      ),
    ).toBe(true);
  }
  expect(
    hasTarget(
      demonstrationActionSchema.parse({
        kind: "navigate",
        url: "https://example.test/",
        transition: "link",
      }),
    ),
  ).toBe(false);
  expect(
    hasTarget(
      demonstrationActionSchema.parse({
        kind: "network",
        url: "https://example.test/",
        method: "POST",
        status: 201,
      }),
    ),
  ).toBe(false);
});
