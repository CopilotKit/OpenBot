import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  type ConsentApp,
  ConnectAppsStep,
} from "@/components/onboarding/connect-apps-step";
import {
  GRANTED_BEAT_MS,
  notificationPreview,
  useNotifyStep,
} from "@/components/onboarding/notify-step";
import { StepIntro } from "@/components/onboarding/onboarding-frame";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { agentKeys } from "@/lib/agents/queries";
import type { AppAccess } from "@/lib/app-access/queries";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's two optional steps. Connect your apps lists the apps the default Bot uses as this
 * person, connects the ones with a sign-in page from here, and comes back to this step. Get
 * notified asks the browser, shows the answer, and moves on.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = {
  id: "general",
  name: "General Assistant",
  title: "Everyday work",
  roleDescription: "",
  avatarSeed: "general",
  visibility: "public",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  mine: false,
};

/** One app as `GET /api/plugins/for/:agentId/apps` answers it, not connected and connectable. */
const app = (over: Partial<AppAccess>): AppAccess => ({
  key: "notion",
  displayName: "Notion",
  logo: null,
  provider: "catalogue",
  account: "personal",
  connect: "oauth",
  authScheme: null,
  accountMode: null,
  state: "not_connected",
  unavailable: null,
  accountHolder: "you",
  asksFirst: false,
  granted: true,
  ownerGrants: "admin",
  givenByOwner: false,
  needsConnect: false,
  connectedAt: null,
  requestKind: null,
  request: null,
  ...over,
});

const originalFetch = globalThis.fetch;
let apps: AppAccess[] | "error";
let connectAnswer: Record<string, unknown>;
let confirmed: boolean;
let requests: { path: string; method: string }[];

let permission: NotificationPermission;
let prompted: NotificationPermission;
let asked: number;
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;

/** The app's one client, without its retries, so a failed read is an answer at once. */
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  requests = [];
  apps = [app({})];
  connectAnswer = {
    authorizationUrl: "https://accounts.example/consent?state=s",
  };
  confirmed = true;
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
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (path === "/api/plugins/for/general/apps") {
        if (apps === "error")
          return Response.json({ error: "nope" }, { status: 503 });
        return Response.json({ apps });
      }
      if (path.endsWith("/connection/confirm"))
        return Response.json({ connected: confirmed });
      if (path.includes("/connect?returnTo="))
        return Response.json(connectAnswer);
      if (path.startsWith("/api/agents"))
        return Response.json({ agents: [BOT] });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
  globalThis.fetch = originalFetch;
  (globalThis as { Notification?: unknown }).Notification =
    originalNotification;
});

function withQueries(children: ReactNode) {
  queryClient.setQueryData(agentKeys.list(false), [BOT]);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function drawConnect(
  props: { failed?: boolean; returned?: ConsentApp | null } = {},
) {
  const left: Array<[string, ConsentApp]> = [];
  const view = render(
    withQueries(
      <ConnectAppsStep
        failed={props.failed ?? false}
        leaveFor={(url, left_) => left.push([url, left_])}
        returned={props.returned ?? null}
      />,
    ),
  );
  return Object.assign(view, { left });
}

/** One app's row, once the list has arrived. */
const rowOf = async (view: ReturnType<typeof render>, key: string) =>
  within(
    await waitFor(() => {
      const row = view.container.querySelector<HTMLElement>(
        `[data-app-row="${key}"]`,
      );
      if (!row) throw new Error(`no ${key} row`);
      return row;
    }),
  );

test("Connect your apps lists the apps the default Bot uses as you, and no team accounts", async () => {
  apps = [
    app({}),
    app({ key: "linear", displayName: "Linear", provider: "composio" }),
    app({ key: "team-drive", displayName: "Team Drive", account: "shared" }),
  ];
  const view = drawConnect();

  expect(await view.findByRole("list", { name: "Apps" })).toBeTruthy();
  const rows = Array.from(
    view.container.querySelectorAll("[data-app-row]"),
  ).map((row) => row.getAttribute("data-app-row"));
  expect(rows).toEqual(["notion", "linear"]);
  expect(requests).toContainEqual({
    path: "/api/plugins/for/general/apps",
    method: "GET",
  });
});

test("Connect starts the real connection, coming back to this step", async () => {
  const view = drawConnect();

  fireEvent.click(await view.findByRole("button", { name: "Connect Notion" }));

  await waitFor(() =>
    expect(view.left).toEqual([
      [
        "https://accounts.example/consent?state=s",
        { serverId: "notion", brokered: false },
      ],
    ]),
  );
  expect(requests).toContainEqual({
    path: "/api/plugins/servers/notion/connect?returnTo=onboarding",
    method: "POST",
  });
});

test("a brokered app leaves saying so, so its return is asked of the vendor", async () => {
  apps = [
    app({
      key: "composio-linear",
      displayName: "Linear",
      provider: "composio",
      connect: "consent",
    }),
  ];
  const view = drawConnect();

  fireEvent.click(await view.findByRole("button", { name: "Connect Linear" }));

  await waitFor(() =>
    expect(view.left[0]?.[1]).toEqual({
      serverId: "composio-linear",
      brokered: true,
    }),
  );
});

test("connected reads Connected, with nothing to press", async () => {
  apps = [app({ state: "ready" })];
  const view = drawConnect();

  expect(
    await (await rowOf(view, "notion")).findByText("Connected"),
  ).toBeTruthy();
  expect((await rowOf(view, "notion")).queryByRole("button")).toBeNull();
});

test("a refused account offers Reconnect", async () => {
  apps = [app({ state: "reconnect" })];
  const view = drawConnect();

  expect(
    await view.findByRole("button", { name: "Reconnect Notion" }),
  ).toBeTruthy();
  expect(
    (await rowOf(view, "notion")).getByText("Needs reconnecting."),
  ).toBeTruthy();
});

test("an app whose key somebody types is connected later, in Connections", async () => {
  apps = [app({ key: "stripe", displayName: "Stripe", connect: "key" })];
  const view = drawConnect();

  expect(
    await (await rowOf(view, "stripe")).findByText(
      "Connect it later in Connections.",
    ),
  ).toBeTruthy();
  expect((await rowOf(view, "stripe")).queryByRole("button")).toBeNull();
});

test("an app the Bot was never given says an admin can give it, with nothing to press", async () => {
  apps = [app({ state: "not_granted" })];
  const view = drawConnect();

  expect(
    await (await rowOf(view, "notion")).findByText(
      "General Assistant can't use it yet. An admin can give it.",
    ),
  ).toBeTruthy();
  expect((await rowOf(view, "notion")).queryByRole("button")).toBeNull();
});

test("an account the vendor already held is recorded on the press, with nowhere to go", async () => {
  apps = [app({ provider: "composio", connect: "consent" })];
  connectAnswer = { connected: true };
  const view = drawConnect();

  fireEvent.click(await view.findByRole("button", { name: "Connect Notion" }));
  apps = [app({ provider: "composio", connect: "consent", state: "ready" })];

  expect(
    await (await rowOf(view, "notion")).findByText("Connected"),
  ).toBeTruthy();
  expect(view.left).toEqual([]);
});

test("back from a brokered consent, the vendor is asked once, and the row reads its answer", async () => {
  apps = [app({ provider: "composio", connect: "consent", state: "ready" })];
  const view = drawConnect({
    returned: { serverId: "notion", brokered: true },
  });

  expect(
    await (await rowOf(view, "notion")).findByText("Connected"),
  ).toBeTruthy();
  await settleReactWork();
  expect(
    requests.filter((request) => request.path.endsWith("/connection/confirm")),
  ).toEqual([
    { path: "/api/plugins/servers/notion/connection/confirm", method: "POST" },
  ]);
  expect(view.queryByRole("alert")).toBeNull();
});

test("a brokered consent the vendor says did not finish is said on the step", async () => {
  apps = [app({ provider: "composio", connect: "consent" })];
  confirmed = false;
  const view = drawConnect({
    returned: { serverId: "notion", brokered: true },
  });

  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't connect Notion. Try again.",
  );
});

test("an OAuth return is not asked of a vendor: the callback already recorded it", async () => {
  apps = [app({ state: "ready" })];
  const view = drawConnect({
    returned: { serverId: "notion", brokered: false },
  });

  await (await rowOf(view, "notion")).findByText("Connected");
  await settleReactWork();
  expect(
    requests.some((request) => request.path.endsWith("/connection/confirm")),
  ).toBe(false);
});

test("a consent that came back failed is said on the step", async () => {
  const view = drawConnect({
    failed: true,
    returned: { serverId: "notion", brokered: false },
  });

  await view.findByRole("list", { name: "Apps" });
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't connect Notion. Try again.",
  );
});

test("a list that could not be read says so, and never claims Connected", async () => {
  apps = "error";
  const view = drawConnect();

  expect(
    await view.findByText(
      "Couldn't load your apps. Continue, and connect them later in Connections.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Connected")).toBeNull();
});

test("no apps to connect says how they arrive", async () => {
  apps = [];
  const view = drawConnect();

  expect(await view.findByText("No apps to connect yet")).toBeTruthy();
});

/** Get notified between two plain steps, in the real frame. */
function NotifyOnboarding() {
  const notify = useNotifyStep("General Assistant");
  return (
    <OnboardingWizard
      initialStepId="notify"
      steps={[
        {
          id: "apps",
          title: "Connect apps",
          intro: () => <StepIntro title="Connect your apps" />,
        },
        notify,
        {
          id: "setup",
          title: "Check your setup",
          intro: () => <StepIntro title="Check your setup" />,
        },
      ]}
    />
  );
}

test("Get notified previews the notification the app really sends", () => {
  const view = render(<NotifyOnboarding />);

  expect(view.getByRole("heading", { name: "Get notified" })).toBeTruthy();
  const preview = notificationPreview("General Assistant");
  expect(preview).toEqual({
    title: "General Assistant needs you",
    body: "1 question, 1 approval",
  });
  expect(
    view.getByRole("img", {
      name: `A notification from OpenBot: ${preview.title}. ${preview.body}.`,
    }),
  ).toBeTruthy();
  expect(view.getByText(preview.title)).toBeTruthy();
  expect(
    view.getByText(
      "Notifications show while OpenBot is open in a browser tab.",
    ),
  ).toBeTruthy();
});

test("Turn on notifications asks the browser, reads Notifications on, then moves on", async () => {
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  const on = await view.findByRole("button", { name: "Notifications on" });
  expect(on.hasAttribute("data-done")).toBe(true);
  expect(asked).toBe(1);
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRANTED_BEAT_MS + 50));
  });
  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
});

test("while the browser's prompt is up, the button waits, and can't be pressed twice", async () => {
  let answer: (value: NotificationPermission) => void = () => {};
  (globalThis as { Notification?: unknown }).Notification = {
    get permission() {
      return permission;
    },
    requestPermission: () =>
      new Promise<NotificationPermission>((resolve) => {
        asked += 1;
        answer = (value) => {
          permission = value;
          resolve(value);
        };
      }),
  };
  refreshNotificationPermission();
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));
  const waiting = await waitFor(() => {
    const button = view.container.querySelector<HTMLButtonElement>(
      "[data-onboarding-primary][data-pending]",
    );
    if (!button) throw new Error("not waiting yet");
    return button;
  });
  expect(waiting.disabled).toBe(true);
  fireEvent.click(waiting);
  expect(asked).toBe(1);

  await act(async () => answer("granted"));
  expect(
    await view.findByRole("button", { name: "Notifications on" }),
  ).toBeTruthy();
});

test("a prompt closed without an answer says where to turn them on, and offers Continue", async () => {
  prompted = "default";
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  const why = await view.findByText(
    "You can turn them on later from a Bot's page.",
  );
  // Said just above the button, in the frame's footer, where a small screen can't scroll it away.
  expect(why.closest("footer")).not.toBeNull();
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
  // Not now's place is kept, so Continue stays where Turn on notifications was.
  expect(
    view.container.querySelector("footer [data-onboarding-secondary-slot]"),
  ).not.toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
});

test("Not now moves on and asks the browser nothing", async () => {
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Not now" }));

  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
  expect(asked).toBe(0);
});

test("a no from the browser says where to allow them, and the button becomes Continue", async () => {
  prompted = "denied";
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  expect(
    await view.findByText(
      "Notifications are blocked for this site. Allow them in your browser's site settings to turn them on.",
    ),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
});

test("a browser with no notifications says so, and offers Continue", () => {
  (globalThis as { Notification?: unknown }).Notification = undefined;
  refreshNotificationPermission();
  const view = render(<NotifyOnboarding />);

  expect(view.getByText("This browser can't show notifications.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
});
