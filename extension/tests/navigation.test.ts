import { expect, test } from "bun:test";
import {
  type NavigationDetails,
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
      transitionType: "link",
      transitionQualifiers: [],
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

test("an address typed into the address bar says so beside CopilotKit's navigationType, as Chrome reports it", () => {
  // End-to-end run 2, row 89035: Wikipedia's address typed into the address bar was recorded as a plain push.
  const value = (details: Partial<NavigationDetails>) =>
    navigationEvent(
      commit({ url: "https://en.wikipedia.org/wiki/Main_Page", ...details }),
      "commit",
      "https://the-internet.herokuapp.com/email_sent",
    ).value as Record<string, unknown>;
  expect(
    value({
      transitionType: "typed",
      transitionQualifiers: ["from_address_bar"],
    }),
  ).toMatchObject({
    navigationType: "push",
    transitionType: "typed",
    transitionQualifiers: ["from_address_bar"],
  });
  expect(
    value({ transitionType: "link", transitionQualifiers: ["forward_back"] }),
  ).toMatchObject({
    navigationType: "traverse",
    transitionType: "link",
    transitionQualifiers: ["forward_back"],
  });
  expect(
    value({ transitionType: "reload", transitionQualifiers: [] }),
  ).toMatchObject({ navigationType: "reload", transitionType: "reload" });
  expect(
    value({
      transitionType: "form_submit",
      transitionQualifiers: ["server_redirect"],
    }),
  ).toMatchObject({
    navigationType: "push",
    transitionType: "form_submit",
    transitionQualifiers: ["server_redirect"],
  });
});
