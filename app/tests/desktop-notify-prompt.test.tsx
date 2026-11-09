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
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { NotifyPrompt } from "@/components/notifications/notify-prompt";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import {
  awayFromOpenBot,
  closeDesktop,
  launchDesktop,
} from "./desktop-notifications.fixture";
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

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010" });
  awayFromOpenBot();
});
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

/**
 * The sidebar's badge, with Expenses asking nothing, then asking one question: what the page
 * notices as a Bot starting to need the person.
 */
async function aBotStartsNeedingThePerson(waitingIn: string | null = null) {
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
          waitingIn: questions > 0 ? waitingIn : null,
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
  await act(settleReactWork);

  questions = 1;
  await act(async () => {
    await client.refetchQueries({ queryKey: botLifecycleKeys.attention });
  });
}

const EXPENSES_NEEDS_YOU = {
  title: "Expenses needs you",
  body: "1 question",
  // The page a click opens (`open_notice_page` in the shell).
  path: "/bots/expenses",
  tag: "openbot-attention-expenses",
};

test("in OpenBot Desktop a Bot that starts needing the person is shown by the desktop app, naming the page a click opens", async () => {
  const desktop = launch();

  await aBotStartsNeedingThePerson();

  // The desktop app's own notice: on Windows the only kind a click in the notification centre
  // brings OpenBot back from (desktop/src-tauri/src/notice.rs).
  await waitFor(() =>
    expect(desktop.toDesktopNotify().map((call) => call.args)).toEqual([
      EXPENSES_NEEDS_YOU,
    ]),
  );
  expect(
    desktop.calls.filter(
      (call) => call.command === "plugin:notification|notify",
    ),
  ).toEqual([]);
});

test("the first question after OpenBot Desktop starts raises its notice, though the desktop app had not said yet that notices are on", async () => {
  // As on Windows right after a launch: the page has not heard back from the desktop app when the
  // first question arrives, and its yes comes back over IPC a moment later. That notice was dropped.
  const desktop = launchDesktop({
    plugin: true,
    windows: true,
    answersLate: true,
  });
  // A fresh page: its first read goes out now and is not answered yet.
  refreshNotificationPermission();

  await aBotStartsNeedingThePerson();
  // The badge shows the question before the desktop app has answered.
  await within(document.body).findByRole("img", { name: "1 thing needs you" });
  await act(settleReactWork);
  expect(desktop.toDesktopNotify()).toEqual([]);
  desktop.answer();

  await waitFor(() =>
    expect(desktop.toDesktopNotify().map((call) => call.args)).toEqual([
      EXPENSES_NEEDS_YOU,
    ]),
  );
  // Exactly one: waiting for the answer raises nothing twice.
  await act(settleReactWork);
  expect(desktop.shown()).toEqual([EXPENSES_NEEDS_YOU]);
});

test("in OpenBot Desktop a notice about a Bot waiting in a conversation opens that conversation", async () => {
  const desktop = launch();

  await aBotStartsNeedingThePerson("channel-plan");

  await waitFor(() =>
    expect(desktop.shown()).toEqual([
      {
        ...EXPENSES_NEEDS_YOU,
        path: "/channel/channel-plan",
        tag: "openbot-channel-plan",
      },
    ]),
  );
});

test("a desktop app without its own notify opens the waiting conversation too", async () => {
  const desktop = launchDesktop({ plugin: true, notifyCommand: false });
  refreshNotificationPermission();

  await aBotStartsNeedingThePerson("channel-plan");

  await waitFor(() =>
    expect(desktop.shown()).toEqual([
      {
        ...EXPENSES_NEEDS_YOU,
        path: "/channel/channel-plan",
        tag: "openbot-channel-plan",
      },
    ]),
  );
});

test("a desktop app without its own notify shows the notice through the notification plugin", async () => {
  const desktop = launchDesktop({ plugin: true, notifyCommand: false });
  refreshNotificationPermission();

  await aBotStartsNeedingThePerson();

  await waitFor(() => expect(desktop.shown()).toEqual([EXPENSES_NEEDS_YOU]));
});

test("in OpenBot Desktop a Bot's notification is shown though the plugin's own first question went unanswered", async () => {
  // As on a Mac with 0.3.3's grant timing: the plugin script asked as the page started, was
  // refused, and its Notification.permission stays "default" for good. The shell answers yes from
  // then on.
  const desktop = launchDesktop({ plugin: true, grantedLate: true });
  await act(settleReactWork);
  expect(desktop.refused()).toEqual([
    "plugin:notification|is_permission_granted",
  ]);
  expect(
    (globalThis as { Notification?: { permission: string } }).Notification
      ?.permission,
  ).toBe("default");
  desktop.grant();
  refreshNotificationPermission();

  await aBotStartsNeedingThePerson();

  await waitFor(() => expect(desktop.shown()).toEqual([EXPENSES_NEEDS_YOU]));
});
