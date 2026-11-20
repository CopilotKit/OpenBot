import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  NOTIFY_PROMPT_KEY,
  NotifyPrompt,
} from "@/components/notifications/notify-prompt";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { settleReactWork } from "./settle-react-work";

/**
 * The offer to turn on notifications, made in a conversation once somebody has asked for
 * something. Only while the browser has not been asked: a yes or a no there hides it for good, and
 * Not now hides it in this browser.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

let permission: NotificationPermission;
let prompted: NotificationPermission;
let asked: number;
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;

beforeEach(() => {
  window.localStorage.clear();
  permission = "default";
  prompted = "granted";
  asked = 0;
  (globalThis as { Notification?: unknown }).Notification = {
    get permission() {
      return permission;
    },
    requestPermission: async () => {
      asked += 1;
      permission = prompted;
      return prompted;
    },
  };
  refreshNotificationPermission();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  (globalThis as { Notification?: unknown }).Notification =
    originalNotification;
  refreshNotificationPermission();
});

const OFFER = "Get notified when your Bot finishes or needs your approval.";

test("a browser not yet asked is offered notifications, with Not now beside it", () => {
  const view = render(<NotifyPrompt />);

  expect(view.getByText(OFFER)).toBeTruthy();
  expect(view.getByRole("button", { name: "Not now" })).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Enable notifications" }),
  ).toBeTruthy();
});

for (const answer of ["granted", "denied"] as const) {
  test(`a browser that already said ${answer} is never offered it`, () => {
    permission = answer;
    refreshNotificationPermission();

    const view = render(<NotifyPrompt />);

    expect(view.queryByText(OFFER)).toBeNull();
  });
}

test("a browser that can't show notifications is never offered them", () => {
  (globalThis as { Notification?: unknown }).Notification = undefined;
  refreshNotificationPermission();

  const view = render(<NotifyPrompt />);

  expect(view.queryByText(OFFER)).toBeNull();
});

test("Not now hides it, asks the browser nothing, and it stays hidden next time", () => {
  const view = render(<NotifyPrompt />);

  fireEvent.click(view.getByRole("button", { name: "Not now" }));

  expect(view.queryByText(OFFER)).toBeNull();
  expect(asked).toBe(0);
  expect(window.localStorage.getItem(NOTIFY_PROMPT_KEY)).not.toBeNull();
  view.unmount();

  const again = render(<NotifyPrompt />);
  expect(again.queryByText(OFFER)).toBeNull();
});

test("Enable notifications asks the browser, and a yes hides it", async () => {
  const view = render(<NotifyPrompt />);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Enable notifications" }));
  });

  expect(asked).toBe(1);
  expect(view.queryByText(OFFER)).toBeNull();
});

test("a browser prompt closed without an answer still hides it", async () => {
  prompted = "default";
  const view = render(<NotifyPrompt />);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Enable notifications" }));
  });

  expect(asked).toBe(1);
  expect(view.queryByText(OFFER)).toBeNull();
  view.unmount();
  expect(render(<NotifyPrompt />).queryByText(OFFER)).toBeNull();
});
