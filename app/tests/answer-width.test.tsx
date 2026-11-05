import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { GroupChat } from "@/components/channels/group-chat";
import { groupKeys } from "@/lib/groups";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's answers and the composer share one column, 768px (`max-w-3xl`), centred and the whole
 * width of a small screen. 768px is the reading width ChatGPT and Claude.ai give an answer; wider, a
 * line of prose gets long enough to be hard to read. The answers' text sits inset in that column, so
 * the composer reaches a little past it on both sides, and a drawer on the composer lines up with
 * the text. Skins keep the column they were drawn with, 672px for both.
 */

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** The width classes of the answers' column and of the composer's. */
function columns(root: HTMLElement) {
  const classes = (selector: string) =>
    (root.querySelector(selector)?.className ?? "").split(/\s+/);
  return {
    answers: classes("[data-transcript-column]"),
    composer: classes('[data-slot="composer-column"]'),
  };
}

/** Centred, the whole width until the cap, and capped at `cap`. */
function centredUpTo(classes: string[], cap: string) {
  expect(classes).toContain("mx-auto");
  expect(classes).toContain("w-full");
  expect(classes.filter((name) => name.startsWith("max-w-"))).toEqual([cap]);
}

test("a conversation's answers and its composer share one column", () => {
  for (const restoring of [false, true]) {
    const view = render(
      <ConversationView
        channelId="c-1"
        messages={[{ id: "u1", role: "user", content: "hello" }]}
        onSubmit={() => {}}
        restoring={restoring}
      />,
    );
    const { answers, composer } = columns(view.container);
    centredUpTo(answers, "max-w-3xl");
    centredUpTo(composer, "max-w-3xl");
    cleanup();
  }
});

test("a group conversation's answers are as wide as a conversation's", async () => {
  queryClient.setQueryData(groupKeys.detail("g-1"), {
    bots: [],
    people: [],
    messages: [],
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <GroupChat channelId="g-1" />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      view.container.querySelector("[data-transcript-column]"),
    ).not.toBeNull(),
  );
  centredUpTo(columns(view.container).answers, "max-w-3xl");
});

test("every skin keeps its answers and its composer in its own column", () => {
  const css = readFileSync(
    new URL("../src/skins/skins.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule =
    /:root\[data-skin\]\s+\[data-transcript-column\],\s*:root\[data-skin\]\s+\[data-slot="composer-column"\]\s*\{([^}]*)\}/.exec(
      css,
    );
  // `max-w-2xl`, read from the theme token.
  expect(rule?.[1]?.trim()).toBe("max-width: var(--container-2xl);");
});
