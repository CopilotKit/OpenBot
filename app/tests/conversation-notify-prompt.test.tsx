import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation offers notifications once somebody has asked a Bot for something, read off the
 * transcript, so the conversation a first message from home opens offers it too. It sits above the
 * composer.
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

const prompt = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-notify-prompt]");

test("a conversation nobody has asked anything in yet offers no notifications", () => {
  const view = render(
    <ConversationView channelId="c-1" messages={[]} onSubmit={() => {}} />,
  );

  expect(prompt(view)).toBeNull();
});

test("a Bot's message alone offers no notifications", () => {
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={[{ id: "a1", role: "assistant", content: "Hello there." }]}
      onSubmit={() => {}}
    />,
  );

  expect(prompt(view)).toBeNull();
});

test("once somebody has asked for something, notifications are offered above the composer", () => {
  const view = render(
    <ConversationView
      channelId="c-1"
      messages={[{ id: "u1", role: "user", content: "Book a table" }]}
      onSubmit={() => {}}
    />,
  );

  const offer = prompt(view);
  expect(offer).not.toBeNull();
  expect(offer?.closest('[data-slot="composer-column"]')).not.toBeNull();
  expect(
    view.getByText(
      "Get notified when your Bot finishes or needs your approval.",
    ),
  ).toBeTruthy();
});
