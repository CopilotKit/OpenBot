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
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

/** Book a call opens the OpenBot for Business page, with its booking calendar, never CopilotKit's generic one. */
const OPENBOT_FOR_BUSINESS = "https://open.bot/business";
/**
 * The calendar Book a demo embeds: the OpenBot for Business event on Calendly, as an inline embed
 * for this page's host, without the event's details. No colours here: the test DOM has no canvas
 * to read the app's tokens from.
 */
const BOOKING_CALENDAR =
  "https://calendly.com/d/dwfr-k64-8d2/openbot-for-business?embed_domain=localhost%3A3010&embed_type=Inline&hide_event_type_details=1";

/**
 * Where somebody is in onboarding lives in the address: `?step=<id>`. A reload stays on the step,
 * browser Back walks back one, and every move is saved, so arriving without a step opens the one
 * they were on. There are three steps at most: Welcome, Book a demo for somebody trying OpenBot
 * alone, and the name, which is left out once the name is known. The last step's button is the way
 * out: it completes onboarding, plays its finish and opens the app.
 */

// The booking calendar's frame keeps its address but never fetches it: no test reaches Calendly.
beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost:3010",
    settings: { navigation: { disableChildFrameNavigation: true } },
  }),
);
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

const originalFetch = globalThis.fetch;
let saved: number;
let saves: number[];
let completed: boolean;
let completeFail: boolean;
let named: string | null;
let localEvaluation: boolean;
/** What `GET /api/setup` answers. */
let checklist: { audience: string; rows: unknown[] };
/** Ask before making changes, as `GET /api/approvals` says it, and every change asked for. */
let askFirst: boolean;
let askFirstChanges: unknown[];
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
    mutations: { ...defaults.mutations, retry: false },
  });
  saved = 0;
  saves = [];
  completed = false;
  completeFail = false;
  named = null;
  localEvaluation = false;
  checklist = {
    audience: "admin",
    rows: [{ ...NO_COMPUTER, status: "ready", ready: true }],
  };
  askFirst = false;
  askFirstChanges = [];
  capabilitiesFail = false;
  capabilitiesAsked = 0;
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
            role: "admin",
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
          if (completeFail)
            return Response.json({ error: "down" }, { status: 503 });
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
      authedRoute.addChildren([homeRoute, wired]),
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
  view.router.state.location.search as { step?: string };
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
    await waitFor(() => {
      const found = view.container.querySelector("[data-onboarding-steps]");
      if (!found) throw new Error("no step menu");
      return found as HTMLElement;
    }),
  );
  return view.findByRole("navigation", { name: "Onboarding steps" });
};
/** The names in the list of steps, without the marks' words. */
const stepNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((item) =>
      item.textContent
        ?.replace(/^\d/, "")
        .replace(/, (done|not yet available)$/, ""),
    );
/** A footer button by name, once the deployment's answer has let it be pressed. */
const ready = async (view: ReturnType<typeof render>, name: string) => {
  const button = await view.findByRole("button", { name });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
};
const continueButton = (view: ReturnType<typeof render>) =>
  ready(view, "Continue");
/** The footer's buttons, in order. */
const footerButtons = (view: ReturnType<typeof render>) =>
  Array.from(view.container.querySelectorAll("footer button")).map(
    (button) => button.textContent,
  );
/** How many scenes the intro's reel plays, read from its dots. */
const reelScenes = (view: ReturnType<typeof render>) =>
  view.container.querySelectorAll("[data-intro-reel] > [aria-hidden] > span")
    .length;
/** Book a demo's booking calendar. */
const calendar = (view: ReturnType<typeof render>) => {
  const found = view.container.querySelector<HTMLIFrameElement>(
    '[data-booking-calendar] iframe[title="Booking calendar"]',
  );
  if (!found) throw new Error("no booking calendar");
  return found;
};
/** Stands in for `window.open`, and puts it back after. */
async function withOpen(run: (opened: unknown[][]) => Promise<void>) {
  const opened: unknown[][] = [];
  const realOpen = window.open;
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as typeof window.open;
  try {
    await run(opened);
  } finally {
    window.open = realOpen;
  }
}

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

  await heading(view, "What should we call you?");
  expect(searchOf(view).step).toBe("name");
  expect(view.history.length).toBe(2);
  await waitFor(() => expect(saves).toContain(3));
});

test("an organization's person has two steps: Welcome, then the name", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  await waitFor(() => expect(capabilitiesAsked).toBeGreaterThan(0));

  expect(stepNames(await openSteps(view))).toEqual([
    "Welcome to OpenBot",
    "What should we call you?",
  ]);
});

test("somebody trying OpenBot alone has three steps: Welcome, Book a demo, then the name", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  await waitFor(() =>
    expect(view.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
      "3",
    ),
  );

  expect(stepNames(await openSteps(view))).toEqual([
    "Welcome to OpenBot",
    "Book a demo",
    "What should we call you?",
  ]);
});

test("on every step, its name in the list of steps is its heading", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  await waitFor(() =>
    expect(view.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
      "3",
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
      step === "selfhost"
        ? view.getByRole("button", { name: "Not now" })
        : await continueButton(view),
    );
    await waitFor(() => expect(searchOf(view).step).not.toBe(step));
  }
  expect(seen).toEqual([
    "Welcome to OpenBot",
    "Book a demo",
    "What should we call you?",
  ]);
});

test("Welcome asks to set up permissions, with Always ask before making changes beside the words, not in the picture", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  const permissions = view.getByRole("heading", {
    name: "Set up your permissions",
  });
  expect(permissions.tagName).toBe("H2");
  const ask = await view.findByRole("switch", {
    name: "Always ask before making changes",
  });
  // A real control: with the words, and nowhere inside the inert illustration.
  expect(ask.closest("[data-onboarding-intro]")).not.toBeNull();
  expect(ask.closest("[data-onboarding-demo]")).toBeNull();
  expect(ask.closest("[inert]")).toBeNull();
  expect(
    view.container.querySelector("[data-onboarding-demo] [data-intro-reel]"),
  ).not.toBeNull();
});

/*
 * REPORTED ON 0.3.3: "Ask before making changes" read as if turning it off also stopped the asks for
 * deleting, sending, sharing and posting, and the sentence saying they always ask sat under the
 * switch where it was missed. What always asks is said first, above the switch, and the switch says
 * it adds routine changes on top (server/src/approvals/policy.ts: safety before the default).
 */
test("Welcome says what always asks before the switch, and the switch says it covers every change", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  const ask = await view.findByRole("switch", {
    name: "Always ask before making changes",
  });
  const always = view.getByText(
    /^Bots always ask for your approval before deleting, sending, sharing, or posting content in your apps or on websites\./,
  );
  expect(always.textContent).toContain(
    "Bots leave payments and account security changes for you to do yourself.",
  );
  // Above the switch in the reading order, not under it.
  expect(
    always.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  const row = ask.closest("[data-slot='item']");
  expect(row?.textContent).toContain("Always ask before making changes");
  expect(row?.textContent).toContain(
    "Require your approval for every change to your apps, websites, and files, including routine edits and updates.",
  );
  expect(row?.textContent).not.toContain(
    "Review a Bot's changes to websites, connected apps, and files.",
  );

  // The workspace exception and where to change it later come after the switch, each on its own.
  const workspace = view.getByText(
    "Bots can create, edit, and delete files in their own workspace without asking, unless this is on.",
  );
  const later = view.getByText(
    "You can change this setting anytime in Settings.",
  );
  expect(
    ask.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(workspace).not.toBe(later);
  expect(view.queryByText(/always wait for you/)).toBeNull();
});

test("switching Always ask before making changes on Welcome saves it, and moves nothing on", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  const ask = await view.findByRole("switch", {
    name: "Always ask before making changes",
  });
  await waitFor(() => expect(ask.hasAttribute("data-disabled")).toBe(false));
  expect(ask.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(ask);

  await waitFor(() => expect(askFirstChanges).toEqual([{ enabled: true }]));
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Always ask before making changes" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(searchOf(view).step).toBe("welcome");
});

test("with a Bot computer, the intro plays all three scenes", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));

  expect(reelScenes(view)).toBe(3);
});

test("without a Bot computer, the intro leaves the computer scene out", async () => {
  checklist = { audience: "member", rows: [NO_COMPUTER] };
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  await waitFor(() => expect(reelScenes(view)).toBe(2));
  expect(view.container.querySelector('[data-scene="computer"]')).toBeNull();
});

test("Continue and Back start the new step's picture at the top of its pane", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  const pane = () =>
    view.container.querySelector("[data-onboarding-demo]") as HTMLElement;
  pane().scrollTop = 120;

  fireEvent.click(await continueButton(view));

  const name = await heading(view, "What should we call you?");
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(pane().scrollTop).toBe(0);

  pane().scrollTop = 120;
  fireEvent.click(back(view));
  const welcome = await heading(view, "Welcome to OpenBot");
  await waitFor(() => expect(document.activeElement).toBe(welcome));
  expect(pane().scrollTop).toBe(0);
});

test("browser Back goes to the step before, not out of onboarding", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  fireEvent.click(await continueButton(view));
  await heading(view, "What should we call you?");

  await act(async () => view.history.back());

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
});

test("Back after Continue returns through history, so Forward still works", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");
  fireEvent.click(await continueButton(view));
  await heading(view, "What should we call you?");

  fireEvent.click(back(view));

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(view.history.canGoBack()).toBe(false);
  await act(async () => view.history.forward());
  expect(await heading(view, "What should we call you?")).toBeTruthy();
});

test("Back on a step opened by reload replaces it with the step before", async () => {
  const view = open("/onboarding?step=name");
  await heading(view, "What should we call you?");

  fireEvent.click(back(view));

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
  expect(view.history.length).toBe(1);
});

test("on a desktop, a step already passed can be picked from the list", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=selfhost");
  await heading(view, "Book a demo");

  const list = await openSteps(view);
  expect(
    within(list).queryByRole("button", { name: /What should we call you/ }),
  ).toBe(null);
  fireEvent.click(within(list).getByRole("button", { name: /Welcome/ }));

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
  // It has seen Book a demo, so the list leads back to it.
  fireEvent.click(
    within(await openSteps(view)).getByRole("button", { name: /Book a demo/ }),
  );
  expect(await heading(view, "Book a demo")).toBeTruthy();
});

test("a reload stays on the step in the address", async () => {
  const view = open("/onboarding?step=name");

  expect(await heading(view, "What should we call you?")).toBeTruthy();
  expect(searchOf(view).step).toBe("name");
});

test("arriving with no step opens the one the server saved", async () => {
  localEvaluation = true;
  saved = 2;
  const view = open("/onboarding");

  expect(await heading(view, "Book a demo")).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("selfhost"));
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
  await heading(first, "What should we call you?");
  const history = first.history;
  first.unmount();
  queryClient.clear();

  // The same history, a new page: what a reload keeps.
  const reloaded = open("/onboarding?step=name", history);
  await heading(reloaded, "What should we call you?");
  fireEvent.click(back(reloaded));

  expect(await heading(reloaded, "Welcome to OpenBot")).toBeTruthy();
  expect(history.length).toBe(2);
  expect(history.canGoBack()).toBe(false);
});

// Saving the name makes it known: the name step stays until onboarding ends, never Welcome again.
test("Get started on the name step saves the name, finishes, plays the orb's finish, then opens the app", async () => {
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
        '[data-onboarding-finish] [data-state="done"]',
      ),
    ).not.toBeNull(),
  );
  expect(named).toBe("Maya");
  expect(completed).toBe(true);
  expect(view.queryByText("Home")).toBeNull();
  // While the orb finishes, the button says what has happened.
  expect(
    view.getByRole("button", { name: "All set" }).hasAttribute("data-done"),
  ).toBe(true);
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
});

test("somebody trying OpenBot alone gets Book a demo before the name, with the booking calendar in the step", async () => {
  localEvaluation = true;
  await withOpen(async (opened) => {
    const view = open("/onboarding?step=welcome");
    await heading(view, "Welcome to OpenBot");
    fireEvent.click(await continueButton(view));

    expect(await heading(view, "Book a demo")).toBeTruthy();
    expect(searchOf(view).step).toBe("selfhost");
    expect(calendar(view).getAttribute("src")).toBe(BOOKING_CALENDAR);
    expect(footerButtons(view)).toEqual(["Back", "Continue", "Not now"]);

    fireEvent.click(await continueButton(view));
    expect(await heading(view, "What should we call you?")).toBeTruthy();
    expect(opened).toEqual([]);
    expect(completed).toBe(false);
  });
});

test("when the calendar can't load, Book a demo shows its picture and Book a call opens the business page in a new tab", async () => {
  localEvaluation = true;
  await withOpen(async (opened) => {
    const view = open("/onboarding?step=selfhost");
    await heading(view, "Book a demo");

    fireEvent.error(calendar(view));

    expect(
      await view.findByText(
        "Couldn't load the calendar. Book a call opens it in your browser.",
      ),
    ).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(
      view.container.querySelector('[data-demo="self-host"]'),
    ).toBeTruthy();
    expect(footerButtons(view)).toEqual(["Back", "Book a call", "Not now"]);

    fireEvent.click(view.getByRole("button", { name: "Book a call" }));
    expect(opened).toEqual([
      [OPENBOT_FOR_BUSINESS, "_blank", "noopener,noreferrer"],
    ]);
    expect(await heading(view, "What should we call you?")).toBeTruthy();
  });
});

test("offline, Book a demo goes straight to Book a call", async () => {
  localEvaluation = true;
  // Shadows the prototype's getter for this test only.
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => false,
  });
  try {
    const view = open("/onboarding?step=selfhost");
    await heading(view, "Book a demo");

    expect(await ready(view, "Book a call")).toBeTruthy();
    expect(view.container.querySelector("iframe")).toBeNull();
  } finally {
    Reflect.deleteProperty(navigator, "onLine");
  }
});

test("a booking made in the calendar takes Not now away; a message from anywhere else does not", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=selfhost");
  await heading(view, "Book a demo");
  const frame = calendar(view);
  const scheduled = { event: "calendly.event_scheduled", payload: {} };

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: scheduled,
        origin: "https://example.com",
        source: frame.contentWindow,
      }),
    );
  });
  expect(footerButtons(view)).toEqual(["Back", "Continue", "Not now"]);

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: scheduled,
        origin: "https://calendly.com",
        source: frame.contentWindow,
      }),
    );
  });
  await waitFor(() =>
    expect(footerButtons(view)).toEqual(["Back", "Continue"]),
  );
});

test("Not now on Book a demo moves on without opening anything", async () => {
  localEvaluation = true;
  await withOpen(async (opened) => {
    const view = open("/onboarding?step=selfhost");
    await heading(view, "Book a demo");

    fireEvent.click(view.getByRole("button", { name: "Not now" }));

    expect(await heading(view, "What should we call you?")).toBeTruthy();
    expect(opened).toEqual([]);
  });
});

test("an organization's people never see the self-hosting step", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  fireEvent.click(await continueButton(view));

  expect(await heading(view, "What should we call you?")).toBeTruthy();
  expect(view.queryByRole("heading", { name: "Book a demo" })).toBeNull();
});

test("the self-hosting step in the address waits for the answer, rather than flashing step 1", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=selfhost");

  expect(await heading(view, "Book a demo")).toBeTruthy();
  expect(
    view.queryByRole("heading", { name: "Welcome to OpenBot" }),
  ).toBeNull();
});

test("until the deployment answers, Welcome's Continue waits; a failure says so and offers Try again", async () => {
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
  expect(await heading(view, "What should we call you?")).toBeTruthy();
  expect(
    view.queryByText("Couldn't load your setup. Try again to continue."),
  ).toBeNull();
});

test.each([
  ["in the address", "/onboarding?step=selfhost", 0],
  ["saved", "/onboarding", 2],
])(
  "a Book a demo step %s for an organization's person opens the name step, and saves that",
  async (_label, path, stored) => {
    saved = stored;
    const view = open(path);

    expect(await heading(view, "What should we call you?")).toBeTruthy();
    await waitFor(() => expect(searchOf(view).step).toBe("name"));
    await waitFor(() => expect(saved).toBe(3));
    expect(saves).not.toContain(2);
  },
);

/*
 * A NAME ALREADY KNOWN IS NOT ASKED FOR. The name step leaves the list, and the last step left
 * finishes onboarding in its place.
 */

test("an organization's person whose name is known sees only Welcome, and Get started opens the app", async () => {
  named = "Maya";
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  const start = await ready(view, "Get started");
  expect(footerButtons(view)).toEqual(["Get started"]);
  // One step: nothing to say where somebody is.
  expect(view.container.querySelector("[data-onboarding-steps]")).toBeNull();
  expect(view.queryByRole("progressbar")).toBeNull();
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();

  fireEvent.click(start);

  await waitFor(() => expect(completed).toBe(true));
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
  expect(view.router.state.location.pathname).toBe("/");
});

test("a name step in the address, once the name is known, opens the last step there is", async () => {
  named = "Maya";
  const view = open("/onboarding?step=name");

  expect(await heading(view, "Welcome to OpenBot")).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
  expect(
    view.queryByRole("heading", { name: "What should we call you?" }),
  ).toBe(null);
});

test("somebody trying OpenBot alone whose name is known ends on Book a demo, where Not now opens the app", async () => {
  named = "Maya";
  localEvaluation = true;
  await withOpen(async (opened) => {
    const view = open("/onboarding?step=welcome");
    await heading(view, "Welcome to OpenBot");
    await waitFor(() =>
      expect(view.getByRole("progressbar").getAttribute("aria-valuemax")).toBe(
        "2",
      ),
    );
    fireEvent.click(await continueButton(view));
    await heading(view, "Book a demo");
    expect(footerButtons(view)).toEqual(["Back", "Get started", "Not now"]);

    fireEvent.click(view.getByRole("button", { name: "Not now" }));

    await waitFor(() => expect(completed).toBe(true));
    await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
      timeout: 3000,
    });
    expect(opened).toEqual([]);
  });
});

test("somebody trying OpenBot alone whose name is known, without the calendar, books a call in a new tab, and that opens the app", async () => {
  named = "Maya";
  localEvaluation = true;
  await withOpen(async (opened) => {
    const view = open("/onboarding?step=selfhost");
    await heading(view, "Book a demo");
    fireEvent.error(calendar(view));

    fireEvent.click(await ready(view, "Book a call"));

    expect(opened).toEqual([
      [OPENBOT_FOR_BUSINESS, "_blank", "noopener,noreferrer"],
    ]);
    await waitFor(() => expect(completed).toBe(true));
    await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
      timeout: 3000,
    });
  });
});

test("a completion that fails on the last step says so, stays, and can be pressed again", async () => {
  named = "Maya";
  completeFail = true;
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenBot");

  fireEvent.click(await ready(view, "Get started"));

  expect(
    (
      await view.findByText("Couldn't finish setting up. Try again.")
    ).getAttribute("role"),
  ).toBe("alert");
  expect(completed).toBe(false);
  expect(view.queryByText("Home")).toBeNull();

  completeFail = false;
  fireEvent.click(await ready(view, "Get started"));
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
});
