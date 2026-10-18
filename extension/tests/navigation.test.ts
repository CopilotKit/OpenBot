import { expect, test } from "bun:test";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import {
  type NavigationDetails,
  navigateStep,
  navigationEvent,
} from "../src/background/navigation";

const commit = (over: Partial<NavigationDetails> = {}): NavigationDetails => ({
  tabId: 7,
  frameId: 0,
  parentFrameId: -1,
  url: "https://crm.example.test/accounts?id=1#top",
  transitionType: "link",
  transitionQualifiers: [],
  timeStamp: 1234,
  ...over,
});

test("a top-frame commit becomes a navigation event with scrubbed urls", () => {
  const event = navigationEvent(
    commit({ url: "https://crm.example.test/accounts?token=abc123secret&p=1" }),
    "commit",
    "https://crm.example.test/login",
  );
  expect(event).toEqual({
    type: "CUSTOM",
    name: "navigation",
    timestamp: 1234,
    value: {
      from: "https://crm.example.test/login",
      to: expect.not.stringContaining("abc123secret"),
      navigationType: "push",
      frameId: 0,
      parentFrameId: -1,
    },
  });
  expect(JSON.stringify(event)).toContain("p=1");
});

test("a sub-frame commit still produces an event with its frame ids", () => {
  const event = navigationEvent(
    commit({ frameId: 3, parentFrameId: 0, url: "https://ads.example.test/f" }),
    "commit",
    undefined,
  );
  expect(event.value).toMatchObject({
    from: "",
    frameId: 3,
    parentFrameId: 0,
    navigationType: "push",
  });
});

test("navigationType follows the transition", () => {
  const type = (details: Partial<NavigationDetails>) =>
    (
      navigationEvent(commit(details), "commit", "https://a.test/").value as {
        navigationType: string;
      }
    ).navigationType;
  expect(type({ transitionType: "reload" })).toBe("reload");
  expect(type({ transitionQualifiers: ["forward_back"] })).toBe("traverse");
  expect(type({ transitionType: "typed" })).toBe("push");
  expect(
    (
      navigationEvent(commit(), "history", "https://a.test/").value as {
        navigationType: string;
      }
    ).navigationType,
  ).toBe("push");
});

test("the event timestamp falls back to the clock without a timeStamp", () => {
  const before = Date.now();
  const event = navigationEvent(
    commit({ timeStamp: undefined }),
    "commit",
    undefined,
  );
  expect(event.timestamp).toBeGreaterThanOrEqual(before);
});

const transitionOf = (action: DemonstrationAction | null) =>
  action?.kind === "navigate" ? action.transition : undefined;

test("frame 0 commits become navigate steps, mapped from the transition", () => {
  const step = (
    details: Partial<NavigationDetails>,
    kind = "commit" as const,
  ) => navigateStep(commit(details), kind);
  expect(step({ transitionType: "link" })).toEqual({
    kind: "navigate",
    url: "https://crm.example.test/accounts",
    transition: "link",
  });
  expect(transitionOf(step({ transitionType: "typed" }))).toBe("typed");
  expect(transitionOf(step({ transitionType: "reload" }))).toBe("reload");
  expect(transitionOf(step({ transitionType: "form_submit" }))).toBe(
    "form_submit",
  );
  expect(transitionOf(step({ transitionType: "auto_bookmark" }))).toBe("other");
  expect(transitionOf(step({ transitionType: undefined }))).toBe("other");
});

test("back_forward comes from the forward_back qualifier", () => {
  expect(
    transitionOf(
      navigateStep(
        commit({
          transitionType: "link",
          transitionQualifiers: ["forward_back"],
        }),
        "commit",
      ),
    ),
  ).toBe("back_forward");
});

test("a history update is a history step", () => {
  expect(navigateStep(commit({ transitionType: "link" }), "history")).toEqual({
    kind: "navigate",
    url: "https://crm.example.test/accounts",
    transition: "history",
  });
});

test("query and fragment never reach the step", () => {
  const step = navigateStep(
    commit({ url: "https://crm.example.test/a/b?token=zzz&x=1#frag" }),
    "commit",
  );
  expect(step?.kind === "navigate" && step.url).toBe(
    "https://crm.example.test/a/b",
  );
});

test("a sub-frame navigation is not a step", () => {
  expect(navigateStep(commit({ frameId: 2 }), "commit")).toBeNull();
  expect(navigateStep(commit({ frameId: 2 }), "history")).toBeNull();
});
