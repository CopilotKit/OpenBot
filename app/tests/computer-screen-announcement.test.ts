import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callComputer } from "@/lib/computers/call";
import {
  onComputerActivity,
  onComputerActivityWithdrawn,
} from "@/lib/copilot/computer-activity";

/**
 * Which computer calls open the live screen, and which take it back.
 *
 * The screen used to open for every call to a Bot's computer, announced before the request went out
 * so a page could be watched while it loaded. Two kinds of call have nothing to show for that: one
 * that touches files or runs a command, which never reaches the screen at all, and one a policy
 * refuses, which is the Bot's intent rather than anything that happened. Both left a person looking
 * at a still screen for an action that was not there.
 */

const realFetch = globalThis.fetch;

type Seen = { botId: string; announcement: number };

let opened: Seen[] = [];
let withdrawn: Seen[] = [];
let stop: (() => void)[] = [];

beforeEach(() => {
  opened = [];
  withdrawn = [];
  stop = [
    onComputerActivity(({ botId, announcement }) =>
      opened.push({ botId, announcement }),
    ),
    onComputerActivityWithdrawn((withdrawal) =>
      withdrawn.push({ ...withdrawal }),
    ),
  ];
});

afterEach(() => {
  for (const off of stop) off();
  globalThis.fetch = realFetch;
});

function serverAnswering(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("a call that happens on the screen", () => {
  test("announces itself, so the page can be watched while it loads", async () => {
    serverAnswering(200, { url: "https://example.com", title: "Example" });

    await callComputer("bot-navigate", "/navigate", {
      method: "POST",
      body: { url: "https://example.com" },
    });

    expect(opened.map((seen) => seen.botId)).toEqual(["bot-navigate"]);
    expect(withdrawn).toEqual([]);
  });

  test("still announces when it fails, because the page may have moved", async () => {
    // Not a refusal: the action was permitted, reached the browser and did not work. What is on
    // screen after it is unknown, so the screen stays the honest place to look.
    serverAnswering(500, { error: "That did not work." });

    await callComputer("bot-failed", "/click", { method: "POST" });

    expect(opened.map((seen) => seen.botId)).toEqual(["bot-failed"]);
    expect(withdrawn).toEqual([]);
  });
});

describe("a call a policy refused", () => {
  test("takes its announcement back, because nothing happened", async () => {
    serverAnswering(403, {
      error: "That is not allowed here.",
      rule: 'url.host == "notion.so"',
    });

    const outcome = await callComputer("bot-refused", "/navigate", {
      method: "POST",
      body: { url: "https://notion.so" },
    });

    expect(outcome.refused).toBe(true);
    expect(opened.map((seen) => seen.botId)).toEqual(["bot-refused"]);
    // This exact announcement, so only a pane that opened for it closes again.
    expect(withdrawn).toEqual([
      { botId: "bot-refused", announcement: opened[0]?.announcement ?? -1 },
    ]);
  });

  test("leaves a pane that a successful call in the same run opened", async () => {
    serverAnswering(200, { url: "https://example.com" });
    await callComputer("bot-mixed", "/navigate", { method: "POST" });

    serverAnswering(403, { error: "That is not allowed here." });
    await callComputer("bot-mixed", "/click", { method: "POST" });

    // Two announcements, and the one withdrawn is the refused click rather than the page.
    expect(opened).toHaveLength(2);
    expect(withdrawn).toEqual([
      { botId: "bot-mixed", announcement: opened[1]?.announcement ?? -1 },
    ]);
    expect(withdrawn[0]?.announcement).not.toBe(opened[0]?.announcement);
  });
});

describe("a call that never reaches the screen", () => {
  test.each(["/files/list", "/files/read", "/files/write", "/exec"])(
    "%s does not open it",
    async (path) => {
      serverAnswering(200, { ok: true });

      await callComputer("bot-offscreen", path, { method: "POST" });

      expect(opened).toEqual([]);
      expect(withdrawn).toEqual([]);
    },
  );

  test("an unrecognised path still opens it", async () => {
    // The default has to stay "announce": a browser action added later and not listed here should
    // behave as every browser action does, rather than silently stop opening the screen.
    serverAnswering(200, { ok: true });

    await callComputer("bot-unknown", "/something-new", { method: "POST" });

    expect(opened.map((seen) => seen.botId)).toEqual(["bot-unknown"]);
  });
});
