import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ask } from "../src/pages/ui/runtime";
import type { PageToBackground } from "../src/protocol/messages";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

describe("ask", () => {
  test("sends exactly the message and resolves the router's answer", async () => {
    const received: unknown[] = [];
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      received.push(message);
      sendResponse({ ok: true, available: true });
      return true;
    });

    const answer = await ask({ type: "page.state" });

    expect(received).toEqual([{ type: "page.state" }]);
    expect(answer).toEqual({ ok: true, available: true });
  });

  test("resolves the refusal instead of throwing when nothing is listening", async () => {
    const answer = await ask({ type: "page.state" });

    expect(answer).toEqual({
      ok: false,
      error: "The Recorder is not answering. Try again.",
    });
  });

  test("resolves the refusal when a listener never answers", async () => {
    chrome.runtime.onMessage.addListener(() => false);

    const message: PageToBackground = { type: "page.state" };
    expect(await ask(message)).toEqual({
      ok: false,
      error: "The Recorder is not answering. Try again.",
    });
  });
});
