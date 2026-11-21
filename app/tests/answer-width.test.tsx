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
 * A Bot's answers and the composer share one column, Figma's 700px (`max-w-page`, which pads 16px a
 * side), centred and the whole width of a small screen. The two columns are the same width, so a
 * message and the box it was typed in share their edges. In a pane narrower than the column, both
 * keep 16px off its edges. Skins keep the column they were drawn with, 672px for both.
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
    centredUpTo(answers, "max-w-page");
    // The composer's column is the answers' own, padding and all: 700px from a 732px pane up, and
    // 16px off each edge below that.
    centredUpTo(composer, "max-w-page");
    expect(answers).toContain("px-4");
    expect(composer).toContain("px-4");
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
  centredUpTo(columns(view.container).answers, "max-w-page");
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
  // OpenBot's `px-4` on the composer's column is taken off again, at a specificity a skin's own
  // padding outranks, so a skin's composer is as wide as it was drawn.
  const padding =
    /:where\(:root\[data-skin\]\)\s+\[data-slot="composer-column"\]\s*\{([^}]*)\}/.exec(
      css,
    );
  expect(padding?.[1]?.trim()).toBe("padding-inline: 0;");
});
