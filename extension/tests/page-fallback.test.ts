import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  acceptPageNetworkEvent,
  createPageFallback,
} from "../src/background/network/fallback";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake({ extensionId: "extension-id" });
});
afterEach(() => {
  fake.uninstall();
});

const targets = () =>
  fake.scripting.executed.map((injection) => ({
    target: injection.target,
    world: injection.world,
    files: injection.files,
    hasFunc: typeof injection.func === "function",
    args: "args" in injection ? injection.args : undefined,
  }));

test("start injects the hook and the configure call into every frame of the recorded tabs only", async () => {
  const fallback = createPageFallback();
  expect(await fallback.start([7])).toBe(true);
  expect(fallback.active()).toBe(true);
  expect(targets()).toEqual([
    {
      target: { tabId: 7, allFrames: true },
      world: "MAIN",
      files: ["page-network.js"],
      hasFunc: false,
      args: undefined,
    },
    {
      target: { tabId: 7, allFrames: true },
      world: "MAIN",
      files: undefined,
      hasFunc: true,
      args: ["extension-id"],
    },
  ]);
  expect(fake.scripting.registered).toEqual([]);
  expect(fake.scripting.executed.every((i) => i.injectImmediately)).toBe(true);
});

test("the configure function calls the hook's configure symbol with the extension id", async () => {
  await createPageFallback().start([7]);
  const configure = fake.scripting.executed[1]?.func as (id: string) => void;
  const seen: string[] = [];
  const symbol = Symbol.for("openbot.recorder.configure");
  const holder = globalThis as unknown as Record<symbol, unknown>;
  holder[symbol] = (id: string) => seen.push(id);
  try {
    configure("abc");
  } finally {
    delete holder[symbol];
  }
  expect(seen).toEqual(["abc"]);
});

test("start reports false when the injection is refused", async () => {
  const fallback = createPageFallback();
  const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = (async () => {
    throw new Error("Cannot access contents of the page");
  }) as typeof chrome.scripting.executeScript;
  try {
    expect(await fallback.start([7])).toBe(false);
  } finally {
    chrome.scripting.executeScript = original;
  }
  expect(fallback.active()).toBe(false);
});

test("addTab injects into the new tab and onCommitted into that frame of a followed tab", async () => {
  const fallback = createPageFallback();
  await fallback.start([7]);
  fake.scripting.executed.length = 0;
  await fallback.addTab(8);
  expect(targets().map((t) => t.target)).toEqual([
    { tabId: 8, allFrames: true },
    { tabId: 8, allFrames: true },
  ]);
  fake.scripting.executed.length = 0;
  await fallback.onCommitted(7, 3);
  expect(targets().map((t) => t.target)).toEqual([
    { tabId: 7, frameIds: [3] },
    { tabId: 7, frameIds: [3] },
  ]);
  fake.scripting.executed.length = 0;
  await fallback.onCommitted(99, 0);
  expect(fake.scripting.executed).toEqual([]);
});

test("stop calls the stop symbol in every frame of the recorded tabs", async () => {
  const fallback = createPageFallback();
  await fallback.start([7]);
  await fallback.addTab(8);
  fake.scripting.executed.length = 0;
  await fallback.stop();
  expect(fallback.active()).toBe(false);
  expect(targets().map((t) => t.target)).toEqual([
    { tabId: 7, allFrames: true },
    { tabId: 8, allFrames: true },
  ]);
  const stopFn = fake.scripting.executed[0]?.func as () => void;
  let stopped = 0;
  const symbol = Symbol.for("openbot.recorder.stop");
  const holder = globalThis as unknown as Record<symbol, unknown>;
  holder[symbol] = () => stopped++;
  try {
    stopFn();
  } finally {
    delete holder[symbol];
  }
  expect(stopped).toBe(1);
  expect(fake.scripting.registered).toEqual([]);
});

const event = (
  value: Record<string, unknown>,
  name = "network",
): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp: 1000,
  value: {
    transport: "fetch",
    method: "GET",
    url: "https://crm.example.test/api/items",
    status: 200,
    ...value,
  } as CapturedEvent["value"],
});

test("a page event is re-masked and marked as page captured", () => {
  const result = acceptPageNetworkEvent(
    event({
      capturedBy: "debugger",
      request: {
        headers: { Authorization: "Bearer abc", Accept: "text/plain" },
        body: { text: "note=hunter22secret&x=1", status: "captured" },
      },
    }),
    new Set(),
  );
  expect(result).not.toBeNull();
  const text = JSON.stringify(result);
  expect(text).not.toContain("Bearer abc");
  expect(text).toContain("Accept");
  expect(
    (result?.value as unknown as { capturedBy: string } | undefined)
      ?.capturedBy,
  ).toBe("page");
});

test("a digest match in a page body is redacted", async () => {
  const { sha256Hex, normaliseSecret } = await import(
    "@openbot/shared/recorder-masking"
  );
  const digest = await sha256Hex(normaliseSecret("correct-horse-battery"));
  const result = acceptPageNetworkEvent(
    event({
      response: {
        headers: { "content-type": "text/plain" },
        body: {
          text: "your key is correct-horse-battery ok",
          status: "captured",
        },
      },
    }),
    new Set([digest]),
  );
  expect(JSON.stringify(result)).not.toContain("correct-horse-battery");
});

test("a 300 KB body is kept whole here: the capture trims it to fit one event", () => {
  const big = JSON.stringify({ rows: "x".repeat(300 * 1024) });
  const result = acceptPageNetworkEvent(
    event({
      response: {
        headers: { "content-type": "application/json" },
        body: { text: big, status: "captured" },
      },
    }),
    new Set(),
  );
  const body = (
    result?.value as unknown as
      | {
          response: { body: { text: string } };
        }
      | undefined
  )?.response.body;
  expect(body?.text.length).toBe(big.length);
});

test("a failed request, whose status is null, is accepted", () => {
  const result = acceptPageNetworkEvent(
    event({ status: null, outcome: "error" }),
    new Set(),
  );
  expect(result?.value).toMatchObject({ status: null, capturedBy: "page" });
});

test("a malformed event is dropped", () => {
  expect(acceptPageNetworkEvent(event({}, "click"), new Set())).toBeNull();
  expect(
    acceptPageNetworkEvent(event({ url: 5 as unknown as string }), new Set()),
  ).toBeNull();
  expect(
    acceptPageNetworkEvent(
      event({ status: "200" as unknown as number }),
      new Set(),
    ),
  ).toBeNull();
  expect(
    acceptPageNetworkEvent(
      { type: "CUSTOM", name: "network", timestamp: 1, value: "x" },
      new Set(),
    ),
  ).toBeNull();
  expect(
    acceptPageNetworkEvent(null as unknown as CapturedEvent, new Set()),
  ).toBeNull();
});
