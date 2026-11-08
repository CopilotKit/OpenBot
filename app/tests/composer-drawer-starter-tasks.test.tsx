import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The question the Bot is waiting on stays whole when the first-use starter tasks are on screen.
 *
 * The question sits in the composer's drawer, which is tucked under the composer: a negative margin
 * and no bottom border, so the two read as one control. The starter tasks and the notifications
 * offer were drawn between the drawer and the composer, so they sat over the drawer's open bottom
 * edge, and in the Desktop's default window (about 1000x800) the question card read as cut off
 * behind the row of starter tasks. Now the drawer is the last thing above the composer, and the
 * starter tasks step aside while it is out: the Bot is waiting on an answer, so they could not be
 * used anyway.
 *
 * happy-dom lays nothing out, so this pins the order that keeps them apart. The geometry was
 * measured in the real app at 1000x800 and 1440x900: nothing overlaps the drawer, and its Send
 * answer button is the element under its own centre.
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
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
  // Undecided, so the notifications offer is on screen too, as it is on a first conversation.
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "default",
    requestPermission: async () => "default",
  };
  refreshNotificationPermission();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  (globalThis as { Notification?: unknown }).Notification =
    originalNotification;
  refreshNotificationPermission();
  GlobalRegistrator.unregister();
});

const STARTER_TASKS = (
  <section aria-label="Starter tasks">
    <button type="button">Find weekend plans</button>
  </section>
);

const QUESTION = (
  <section aria-label="Personal Assistant is waiting on your answer">
    <p>Which city should I look in?</p>
    <button type="button">Send answer</button>
  </section>
);

const MESSAGES = [
  { id: "u1", role: "user" as const, content: "Find three things to do" },
];

function column(view: ReturnType<typeof render>) {
  const found = view.container.querySelector('[data-slot="composer-column"]');
  if (!found) throw new Error("No composer column");
  return found;
}

/** The composer's own element in the column: the wrapper around its form. */
function composer(view: ReturnType<typeof render>) {
  const form = column(view).querySelector('form[data-slot="composer"]');
  const wrapper = form?.parentElement;
  if (!wrapper || wrapper.parentElement !== column(view))
    throw new Error("No composer in the column");
  return wrapper;
}

test("while the Bot waits on an answer, nothing is drawn between its question and the composer", () => {
  const view = render(
    <ConversationView
      attached={QUESTION}
      channelId="c-1"
      messages={MESSAGES}
      onSubmit={() => {}}
      starterSuggestions={STARTER_TASKS}
    />,
  );

  const drawer = column(view).querySelector('[data-slot="composer-drawer"]');
  expect(drawer).not.toBeNull();
  expect(
    drawer?.querySelector(
      'section[aria-label="Personal Assistant is waiting on your answer"]',
    ),
  ).not.toBeNull();
  // Tucked under the composer, so the composer must be the very next thing.
  expect(drawer?.nextElementSibling).toBe(composer(view));
  // The starter tasks step aside while the question is out.
  expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull();
  // The notifications offer is still made, above the question rather than over its edge.
  const offer = column(view).querySelector("[data-notify-prompt]");
  expect(offer).not.toBeNull();
  expect(
    offer && drawer
      ? offer.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING
      : 0,
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Send answer" })).toBeTruthy();
});

/*
 * Reported from the Desktop: in a pane narrower than the 768px composer column, the composer and the
 * starter tasks ran to the pane's border while the transcript kept 16px a side. The column now pads
 * like the transcript's (`px-4`) and is allowed 2rem past `max-w-3xl` to pay for it, so a wide pane
 * still draws the same 768px composer. Measured in a render of this view: 768px wide at 1000px and
 * 820px, and 16px off each edge at 790px, 640px and 420px. happy-dom lays nothing out, so this pins
 * the classes.
 */
test("the composer column keeps the transcript's side inset in a narrow pane", () => {
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={MESSAGES}
      onSubmit={() => {}}
      starterSuggestions={STARTER_TASKS}
    />,
  );

  const classes = column(view).className.split(/\s+/);
  expect(classes).toContain("px-4");
  expect(classes).toContain("max-w-[calc(var(--container-3xl)+2rem)]");
  expect(classes).not.toContain("px-0");
  expect(classes).not.toContain("max-w-3xl");
});

test("with no question waiting, the starter tasks sit directly above the composer", () => {
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={MESSAGES}
      onSubmit={() => {}}
      starterSuggestions={STARTER_TASKS}
    />,
  );

  const tasks = view.getByRole("region", { name: "Starter tasks" });
  expect(
    column(view).querySelector('[data-slot="composer-drawer"]'),
  ).toBeNull();
  expect(tasks.nextElementSibling).toBe(composer(view));
  expect(view.getByRole("button", { name: "Find weekend plans" })).toBeTruthy();
});
