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
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { refreshNotificationPermission } from "@/lib/notifications/permission";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

/**
 * Where somebody is in onboarding lives in the address: `?step=<id>`. A reload stays on the step,
 * browser Back walks back one, a consent comes back to the step it left from, and every move is
 * saved, so arriving without a step opens the one they were on. The name step is the way out: Get
 * started saves the name, completes onboarding, shows the orb done and opens the app.
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
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  mine: false,
};

const CHECKLIST = {
  audience: "admin",
  rows: [
    {
      id: "model",
      scope: "deployment",
      title: "AI model",
      required: true,
      status: "needs_setup",
      ready: false,
      detail: "Without a model key, OpenBot can't answer.",
      fix: {
        kind: "env",
        names: ["OPENAI_API_KEY"],
        docsUrl: "https://github.com/CopilotKit/openbot#quick-start",
        page: { label: "Credentials", path: "/admin/credentials" },
      },
    },
  ],
};

const originalFetch = globalThis.fetch;
let saved: number;
let saves: number[];
let completed: boolean;
let named: string | null;
let localEvaluation: boolean;
let role: "admin" | "user";
/** What `GET /api/setup` answers. */
let checklist: { audience: string; rows: unknown[] };
/** Ask before making changes, as `GET /api/approvals` says it, and every change asked for. */
let askFirst: boolean;
let askFirstChanges: unknown[];
/** The apps `GET /api/plugins/for/general/apps` answers with. */
let appList: unknown[];
/** Whether `/api/capabilities` answers, and how many times it was asked. */
let capabilitiesFail: boolean;
let capabilitiesAsked: number;
const defaults = queryClient.getDefaultOptions();

beforeEach(() => {
  // Another file's screens may have cached the signed-in person in the app's one query client.
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  saved = 0;
  saves = [];
  completed = false;
  named = null;
  localEvaluation = false;
  role = "admin";
  checklist = CHECKLIST;
  askFirst = false;
  askFirstChanges = [];
  appList = [
    {
      key: "notion",
      displayName: "Notion",
      logo: null,
      account: "personal",
      connect: "oauth",
      state: "not_connected",
    },
  ];
  capabilitiesFail = false;
  capabilitiesAsked = 0;
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "default",
    requestPermission: async () => "default",
  };
  refreshNotificationPermission();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/me")
        return Response.json({
          user: {
            id: "person-1",
            email: "maya@example.com",
            name: named ?? "maya@example.com",
            needsName: named === null,
            role,
            onboarding: {
              step: saved,
              completedAt: completed ? "2026-10-23T00:00:00Z" : null,
            },
          },
        });
      if (path === "/api/me/profile" && method === "PATCH") {
        named = (JSON.parse(String(init?.body)) as { name: string }).name;
        return Response.json({ profile: { name: named, needsName: false } });
      }
      if (path === "/api/me/onboarding" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          step?: number;
          completed?: boolean;
        };
        if (body.completed) {
          completed = true;
          return Response.json({
            onboarding: { step: saved, completedAt: "2026-10-23T00:00:00Z" },
          });
        }
        if (body.step === undefined) throw new Error("Missing onboarding step");
        saves.push(body.step);
        saved = body.step;
        return Response.json({
          onboarding: { step: saved, completedAt: null },
        });
      }
      if (path === "/api/capabilities") {
        capabilitiesAsked += 1;
        return capabilitiesFail
          ? Response.json({ error: "down" }, { status: 503 })
          : Response.json({ localEvaluation });
      }
      if (path.startsWith("/api/agents"))
        return Response.json({ agents: [BOT] });
      if (path === "/api/plugins/for/general/apps")
        return Response.json({ apps: appList });
      if (path === "/api/setup") return Response.json({ checklist });
      if (path === "/api/approvals")
        return Response.json({ enabled: askFirst, rules: [], pending: [] });
      if (path === "/api/approvals/preferences" && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { enabled?: boolean };
        askFirstChanges.push(body);
        if (body.enabled !== undefined) askFirst = body.enabled;
        return Response.json({ enabled: askFirst });
      }
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
  window.sessionStorage.clear();
});

function open(path: string, given?: ReturnType<typeof createMemoryHistory>) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const homeRoute = createRoute({
    path: "/",
    getParentRoute: () => authedRoute,
    component: () => <p>Home</p>,
  });
  const credentialsRoute = createRoute({
    path: "/admin/credentials",
    getParentRoute: () => authedRoute,
    component: () => <p>Credentials page</p>,
  });
  const wired = (
    OnboardingRoute as unknown as {
      update: (options: unknown) => typeof OnboardingRoute;
    }
  ).update({
    id: "/onboarding",
    path: "/onboarding",
    getParentRoute: () => authedRoute,
  });
  const history = given ?? createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([homeRoute, credentialsRoute, wired]),
    ]),
    history,
    context: { queryClient },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router, history });
}

const heading = (view: ReturnType<typeof render>, name: string) =>
  view.findByRole("heading", { name });
const searchOf = (view: ReturnType<typeof open>) =>
  view.router.state.location.search as {
    step?: string;
    connected?: string;
    open?: string;
  };
/** The phone's Back, at the top left. The desktop's is the same button beside Continue. */
const back = (view: ReturnType<typeof render>) => {
  const found = view.container.querySelector<HTMLButtonElement>(
    '[data-onboarding-back="phone"]',
  );
  if (!found) throw new Error("no Back");
  return found;
};
/** The desktop's list of steps, opened from "Step N of M" above the heading. */
const openSteps = async (view: ReturnType<typeof render>) => {
  fireEvent.click(
    view.container.querySelector("[data-onboarding-steps]") as HTMLElement,
  );
  return view.findByRole("navigation", { name: "Onboarding steps" });
};
/** Continue, once the deployment's answer has let it be pressed. */
const continueButton = async (view: ReturnType<typeof render>) => {
  const button = await view.findByRole("button", { name: "Continue" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
};

test("arriving without a step writes the first one into the address, in place", async () => {
  const view = open("/onboarding");

  await heading(view, "Welcome to OpenBot");
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
  // In place: nothing behind it to go Back to inside onboarding.
  expect(view.history.length).toBe(1);
});

test("Continue adds a step to the address and to history, and saves it", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  fireEvent.click(await continueButton(view));

  await heading(view, "Each Bot has its own browser and files");
  expect(searchOf(view).step).toBe("computer");
  expect(view.history.length).toBe(2);
  await waitFor(() => expect(saves).toContain(2));
});

test("the steps run welcome, computer, team, approval, setup, apps, notify, name", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  const list = await openSteps(view);
  await waitFor(() =>
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) =>
          item.textContent
            ?.replace(/^\d/, "")
            .replace(/, (done|not yet available)$/, ""),
        ),
    ).toEqual([
      "Welcome to OpenBot",
      "Each Bot has its own browser and files",
      "Pick a Bot or make your own",
      "You decide what it asks about",
      "Check your setup",
      "Connect your apps",
      "Get notified",
      "What should we call you?",
    ]),
  );
  fireEvent.keyDown(list, { key: "Escape" });
  for (const next of [
    "Each Bot has its own browser and files",
    "Pick a Bot or make your own",
    "You decide what it asks about",
  ]) {
    fireEvent.click(await continueButton(view));
    await heading(view, next);
  }
  fireEvent.click(await continueButton(view));
  await heading(view, "Check your setup");
  fireEvent.click(await continueButton(view));
  await heading(view, "Connect your apps");
});

test("on every step, its name in the list of steps is its heading", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  await waitFor(() =>
    expect(view.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
      "9",
    ),
  );

  const seen: string[] = [];
  for (;;) {
    const h1 = view.container.querySelector(
      `[data-step="${searchOf(view).step}"] h1`,
    );
    const list = await openSteps(view);
    const current = list.querySelector('[aria-current="step"]');
    expect(current?.textContent?.replace(/^\d/, "")).toBe(
      h1?.textContent ?? "",
    );
    seen.push(h1?.textContent ?? "");
    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() =>
      expect(
        view.queryByRole("navigation", { name: "Onboarding steps" }),
      ).toBeNull(),
    );
    if (searchOf(view).step === "name") break;
    const step = searchOf(view).step;
    fireEvent.click(
      step === "apps" || step === "notify"
        ? view.getByRole("button", { name: "Not now" })
        : await continueButton(view),
    );
    await waitFor(() => expect(searchOf(view).step).not.toBe(step));
  }
  expect(seen).toHaveLength(9);
});

/** A Bot computer row as the server sends it: none configured. */
const NO_COMPUTER = {
  id: "computer",
  scope: "deployment",
  title: "Bot computer",
  required: false,
  status: "needs_setup",
  ready: false,
  detail: "Your admin sets this up.",
  fix: null,
};

test("with a Bot computer, step 2 says each Bot has its own browser and files", async () => {
  checklist = {
    audience: "admin",
    rows: [{ ...NO_COMPUTER, status: "ready", ready: true }],
  };
  const view = open("/onboarding?step=computer");

  expect(
    await heading(view, "Each Bot has its own browser and files"),
  ).toBeTruthy();
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  expect(view.queryByText(/doesn't have one yet/)).toBeNull();
});

test("without a Bot computer, step 2 promises nothing it can't keep, and says who adds one", async () => {
  checklist = { audience: "member", rows: [NO_COMPUTER] };
  role = "user";
  const view = open("/onboarding?step=computer");

  expect(
    await heading(view, "A Bot can have its own browser and files"),
  ).toBeTruthy();
  expect(
    view.getByText("OpenBot doesn't have one yet. Your admin sets it up."),
  ).toBeTruthy();
  expect(
    view.queryByRole("heading", {
      name: "Each Bot has its own browser and files",
    }),
  ).toBeNull();
});

test("an admin without a Bot computer is pointed at Check your setup", async () => {
  checklist = { audience: "admin", rows: [NO_COMPUTER] };
  const view = open("/onboarding?step=computer");

  await heading(view, "A Bot can have its own browser and files");
  expect(
    view.getByText(
      "OpenBot doesn't have one yet. Check your setup shows how to add one.",
    ),
  ).toBeTruthy();
});

test("the approval step offers Ask before making changes right there, and switching it saves it", async () => {
  const view = open("/onboarding?step=approval");
  await heading(view, "You decide what it asks about");

  const ask = await view.findByRole("switch", {
    name: "Ask before making changes",
  });
  await waitFor(() => expect(ask.hasAttribute("data-disabled")).toBe(false));
  expect(ask.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(ask);

  await waitFor(() => expect(askFirstChanges).toEqual([{ enabled: true }]));
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Ask before making changes" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  // Still on the step: switching it moves nothing on.
  expect(searchOf(view).step).toBe("approval");
});

test("Continue and Back start the new step's picture at the top of its pane", async () => {
  const view = open("/onboarding?step=computer");
  await heading(view, "Each Bot has its own browser and files");
  const pane = () =>
    view.container.querySelector("[data-onboarding-demo]") as HTMLElement;
  pane().scrollTop = 120;

  fireEvent.click(await continueButton(view));

  const team = await heading(view, "Pick a Bot or make your own");
  await waitFor(() => expect(document.activeElement).toBe(team));
  expect(pane().scrollTop).toBe(0);

  pane().scrollTop = 120;
  fireEvent.click(back(view));
  const computer = await heading(
    view,
    "Each Bot has its own browser and files",
  );
  await waitFor(() => expect(document.activeElement).toBe(computer));
  expect(pane().scrollTop).toBe(0);
});

test("browser Back goes to the step before, not out of onboarding", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  fireEvent.click(await continueButton(view));
  await heading(view, "Each Bot has its own browser and files");

  await act(async () => view.history.back());

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
});

test("Back after Continue returns through history, so Forward still works", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  fireEvent.click(await continueButton(view));
  await heading(view, "Each Bot has its own browser and files");

  fireEvent.click(back(view));

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(view.history.canGoBack()).toBe(false);
  await act(async () => view.history.forward());
  expect(
    await heading(view, "Each Bot has its own browser and files"),
  ).toBeTruthy();
});

test("Back on a step opened by reload replaces it with the step before", async () => {
  const view = open("/onboarding?step=team");
  await heading(view, "Pick a Bot or make your own");

  fireEvent.click(back(view));

  expect(
    await heading(view, "Each Bot has its own browser and files"),
  ).toBeTruthy();
  expect(searchOf(view).step).toBe("computer");
  expect(view.history.length).toBe(1);
});

test("on a desktop, a step already passed can be picked from the list", async () => {
  const view = open("/onboarding?step=approval");
  await heading(view, "You decide what it asks about");

  const list = await openSteps(view);
  expect(
    within(list).queryByRole("button", { name: /Connect your apps/ }),
  ).toBe(null);
  fireEvent.click(within(list).getByRole("button", { name: /Welcome/ }));

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
  // It has seen the approval step, so the list leads back to it.
  fireEvent.click(
    within(await openSteps(view)).getByRole("button", {
      name: /You decide what it asks/,
    }),
  );
  expect(await heading(view, "You decide what it asks about")).toBeTruthy();
});

test("a reload stays on the step in the address", async () => {
  const view = open("/onboarding?step=apps");

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  expect(searchOf(view).step).toBe("apps");
});

test("arriving with no step opens the one the server saved", async () => {
  saved = 7;
  const view = open("/onboarding");

  expect(await heading(view, "Get notified")).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("notify"));
});

test("a failed consent says so on its step, and only `connected` leaves the address", async () => {
  const view = open("/onboarding?step=apps&connected=failed");

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't connect that app. Try again.",
  );
  await waitFor(() => expect(searchOf(view)).toEqual({ step: "apps" }));
});

test("a step that isn't one is ignored", async () => {
  const view = open("/onboarding?step=nonsense");

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
});

test("after a reload, Back still returns through history, not a second entry", async () => {
  const first = open("/onboarding?step=welcome");
  await heading(first, "Welcome to OpenBot");
  fireEvent.click(await continueButton(first));
  await heading(first, "Each Bot has its own browser and files");
  const history = first.history;
  first.unmount();
  queryClient.clear();

  // The same history, a new page: what a reload keeps.
  const reloaded = open("/onboarding?step=computer", history);
  await heading(reloaded, "Each Bot has its own browser and files");
  fireEvent.click(back(reloaded));

  expect(await heading(reloaded, "Welcome to OpenBot")).toBeTruthy();
  expect(history.length).toBe(2);
  expect(history.canGoBack()).toBe(false);
});

test("back from a consent, browser Back goes to the step before, not to the vendor", async () => {
  window.sessionStorage.setItem(
    "openbot-onboarding-consent",
    JSON.stringify({
      step: "apps",
      entry: "the-entry-that-left",
      app: { serverId: "notion", brokered: false },
    }),
  );
  const view = open("/onboarding?step=apps&connected=failed");

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  await waitFor(() => expect(view.history.length).toBe(2));
  expect(searchOf(view)).toEqual({ step: "apps" });
  // The app it left for is named, once its row has arrived.
  await waitFor(async () =>
    expect((await view.findByRole("alert")).textContent).toBe(
      "Couldn't connect Notion. Try again.",
    ),
  );
  expect(
    window.sessionStorage.getItem("openbot-onboarding-consent"),
  ).toBeNull();

  await act(async () => view.history.back());
  expect(await heading(view, "Check your setup")).toBeTruthy();
});

test("the failed line goes once the person moves on, and doesn't come back with Back", async () => {
  const view = open("/onboarding?step=apps&connected=failed");
  await view.findByRole("alert");

  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  await heading(view, "Get notified");
  fireEvent.click(back(view));

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  await settleReactWork();
  expect(view.queryByRole("alert")).toBeNull();
});

test("Get started on the name step saves the name, finishes, shows the orb done, then opens the app", async () => {
  const view = open("/onboarding?step=name");
  await heading(view, "What should we call you?");
  // The frame's primary is the name form's Get started, not a Continue.
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  // Under the orb: on a phone the picture comes first.
  expect(
    view.container.querySelector("[data-onboarding-demo]")?.className,
  ).toContain("row-start-2");

  await userEvent.setup({ document }).type(view.getByLabelText("Name"), "Maya");
  fireEvent.click(view.getByRole("button", { name: "Get started" }));

  await waitFor(() =>
    expect(
      view.container.querySelector(
        '[data-onboarding-finish][data-state="done"]',
      ),
    ).not.toBeNull(),
  );
  expect(named).toBe("Maya");
  expect(completed).toBe(true);
  expect(view.queryByText("Home")).toBeNull();
  // While the orb shows done, the button says what has happened.
  expect(
    view.getByRole("button", { name: "All set" }).hasAttribute("data-done"),
  ).toBe(true);
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
});

test("a checklist link moves on, says on every step after it what opens, and opens it at the end", async () => {
  const view = open("/onboarding?step=setup");
  await heading(view, "Check your setup");

  fireEvent.click(await view.findByRole("link", { name: "Credentials" }));

  // On to the next step, not straight to the end: the steps between still come.
  await heading(view, "Connect your apps");
  expect(searchOf(view)).toEqual({ step: "apps", open: "/admin/credentials" });
  expect(
    await view.findByText("Credentials opens once you get started."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  await heading(view, "Get notified");
  expect(
    view.getByText("Credentials opens once you get started."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  await heading(view, "What should we call you?");
  expect(searchOf(view)).toEqual({ step: "name", open: "/admin/credentials" });
  expect(
    view.getByText("Credentials opens once you get started."),
  ).toBeTruthy();
  expect(completed).toBe(false);

  await userEvent.setup({ document }).type(view.getByLabelText("Name"), "Maya");
  fireEvent.click(view.getByRole("button", { name: "Get started" }));
  await waitFor(() => expect(view.getByText("Credentials page")).toBeTruthy(), {
    timeout: 3000,
  });
  expect(completed).toBe(true);
});

test("an admin's Add apps keeps onboarding's place: on to Get notified, with Plugins opening at the end", async () => {
  appList = [];
  const view = open("/onboarding?step=apps");
  await heading(view, "Connect your apps");

  fireEvent.click(await view.findByRole("button", { name: "Add apps" }));

  await heading(view, "Get notified");
  expect(searchOf(view)).toEqual({ step: "notify", open: "/admin/plugins" });
  expect(view.getByText("Plugins opens once you get started.")).toBeTruthy();
  expect(completed).toBe(false);
});

test("Check your setup tells an admin where to check again after onboarding", async () => {
  const view = open("/onboarding?step=setup");
  await heading(view, "Check your setup");

  expect(
    await view.findByText("Check again any time in Settings → Setup."),
  ).toBeTruthy();
});

test("a member isn't pointed at a Settings page they don't get", async () => {
  role = "user";
  const view = open("/onboarding?step=setup");
  await heading(view, "Check your setup");
  await view.findByRole("list", { name: "Setup" });

  expect(view.queryByText("Check again any time in Settings → Setup.")).toBe(
    null,
  );
});

test("a page to open that isn't one of this app's is dropped", async () => {
  const view = open("/onboarding?step=name&open=https%3A%2F%2Fevil.test");

  await heading(view, "What should we call you?");
  expect(searchOf(view).open).toBeUndefined();
});

test("Skip intro reaches Check your setup, survives reload, and Back returns to the step it skipped from", async () => {
  localEvaluation = true;
  const first = open("/onboarding?step=welcome");
  await heading(first, "Welcome to OpenBot");
  await waitFor(() =>
    expect(first.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
      "9",
    ),
  );
  fireEvent.click(first.getByRole("button", { name: "Skip intro" }));
  await heading(first, "Check your setup");
  await waitFor(() => expect(saves).toContain(8));
  expect(completed).toBe(false);
  const history = first.history;
  first.unmount();
  queryClient.clear();

  const view = open("/onboarding?step=setup", history);
  await heading(view, "Check your setup");
  fireEvent.click(back(view));
  await heading(view, "Welcome to OpenBot");
  await act(async () => history.forward());
  await heading(view, "Check your setup");
  fireEvent.click(await continueButton(view));
  await heading(view, "Connect your apps");
  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  await heading(view, "Get notified");
  expect(completed).toBe(false);
});

test("the last intro step has no Skip intro, since Continue goes to the same place", async () => {
  const view = open("/onboarding?step=team");
  await heading(view, "Pick a Bot or make your own");
  expect(view.getByRole("button", { name: "Skip intro" })).toBeTruthy();

  fireEvent.click(await continueButton(view));

  await heading(view, "You decide what it asks about");
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Skip intro" })).toBeNull(),
  );
});

test("somebody trying OpenBot alone gets the self-hosting step, with Talk to an engineer", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=approval");
  await heading(view, "You decide what it asks about");

  fireEvent.click(await continueButton(view));

  expect(await heading(view, "It runs on your machine")).toBeTruthy();
  expect(searchOf(view).step).toBe("selfhost");
  const engineer = view.getByRole("link", { name: "Talk to an engineer" });
  expect(engineer.getAttribute("target")).toBe("_blank");
  // Two actions, Back and Continue: no Skip intro, and the engineer is a link in the words.
  expect(
    Array.from(view.container.querySelectorAll("footer button")).map(
      (button) => button.textContent,
    ),
  ).toEqual(["Back", "Continue"]);
  expect(engineer.closest("p")?.textContent).toBe(
    "Taking it to your team? Talk to an engineer",
  );
  fireEvent.click(await continueButton(view));
  expect(await heading(view, "Check your setup")).toBeTruthy();
});

test("an organization's people never see the self-hosting step", async () => {
  const view = open("/onboarding?step=approval");
  await heading(view, "You decide what it asks about");

  fireEvent.click(await continueButton(view));

  expect(await heading(view, "Check your setup")).toBeTruthy();
  expect(view.queryByText("Running it yourself")).toBeNull();
});

test("the self-hosting step in the address waits for the answer, rather than flashing step 1", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=selfhost");

  expect(await heading(view, "It runs on your machine")).toBeTruthy();
  expect(
    view.queryByRole("heading", { name: "Welcome to OpenBot" }),
  ).toBeNull();
});

test("until the deployment answers, the intro's Continue waits; a failure says so and offers Try again", async () => {
  capabilitiesFail = true;
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  expect(
    (
      await view.findByText("Couldn't load your setup. Try again to continue.")
    ).getAttribute("role"),
  ).toBe("alert");
  expect(
    view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(true);

  capabilitiesFail = false;
  const asked = capabilitiesAsked;
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(capabilitiesAsked).toBeGreaterThan(asked));
  fireEvent.click(await continueButton(view));
  expect(
    await heading(view, "Each Bot has its own browser and files"),
  ).toBeTruthy();
  expect(
    view.queryByText("Couldn't load your setup. Try again to continue."),
  ).toBeNull();
});

test("a consent returns Back to the step it was reached from, wherever that was", async () => {
  window.sessionStorage.setItem(
    "openbot-onboarding-consent",
    JSON.stringify({
      step: "apps",
      from: "welcome",
      entry: "the-entry-that-left",
    }),
  );
  const view = open("/onboarding?step=apps&connected=failed");
  await heading(view, "Connect your apps");
  await waitFor(() =>
    expect(view.router.state.location.state).toMatchObject({
      onboardingFrom: "welcome",
    }),
  );
  fireEvent.click(back(view));
  await heading(view, "Welcome to OpenBot");
});
