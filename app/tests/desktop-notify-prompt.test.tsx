import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { NotifyPrompt } from "@/components/notifications/notify-prompt";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { closeDesktop, launchDesktop } from "./desktop-notifications.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The offer to turn on notifications, in the OpenBot Desktop window. There the desktop app shows
 * them, through Tauri's notification plugin, and it needs nobody's yes to: so the page does not
 * ask, on any launch. It used to ask on every launch, because it read the window's own answer,
 * which a WKWebView can never make "granted", and the yes it remembered was kept per port.
 */

const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010" }));
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  closeDesktop();
  globalThis.fetch = originalFetch;
  (globalThis as { Notification?: unknown }).Notification =
    originalNotification;
  window.localStorage.clear();
  refreshNotificationPermission();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const OFFER = "Get notified when your Bot finishes or needs your approval.";

/** A launch of OpenBot Desktop: the window's scripts, then a page that has read nothing yet. */
function launch() {
  const desktop = launchDesktop({ plugin: true });
  refreshNotificationPermission();
  return desktop;
}

test("OpenBot Desktop never offers notifications: not on opening, not on coming back, not after reopening on another port", async () => {
  launch();

  const first = render(<NotifyPrompt />);
  expect(first.queryByText(OFFER)).toBeNull();
  await act(settleReactWork);
  expect(first.queryByText(OFFER)).toBeNull();
  first.unmount();

  // Back to the conversation, in the same launch.
  const again = render(<NotifyPrompt />);
  expect(again.queryByText(OFFER)).toBeNull();
  again.unmount();

  // Quit and reopen on another port: another origin, so nothing this page stored is there.
  window.localStorage.clear();
  launch();
  const reopened = render(<NotifyPrompt />);
  expect(reopened.queryByText(OFFER)).toBeNull();
  await act(settleReactWork);
  expect(reopened.queryByText(OFFER)).toBeNull();
});

test("in OpenBot Desktop a Bot that starts needing the person is shown by the system, through the plugin, naming the page a click opens", async () => {
  const desktop = launch();
  let questions = 0;
  globalThis.fetch = (async () =>
    Response.json({
      bots: [
        {
          agentId: "expenses",
          name: "Expenses",
          questions,
          approvals: 0,
          handoffs: 0,
          unread: 0,
          paused: false,
          notify: "all",
          items: 0,
          tasks: { needsInput: 0, ready: 0, failed: 0 },
        },
      ],
      lastPingId: null,
    })) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BotsNavBadge />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(client.getQueryState(botLifecycleKeys.attention)?.status).toBe(
      "success",
    ),
  );

  questions = 1;
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });

  await waitFor(() =>
    expect(desktop.shown()).toEqual([
      {
        title: "Expenses needs you",
        body: "1 question",
        tag: "openbot-attention-expenses",
        // The page a click opens (`open_from_notification` in the shell).
        extra: { path: "/bots/expenses" },
      },
    ]),
  );
});
