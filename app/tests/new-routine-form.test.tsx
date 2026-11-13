import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewRoutinePage } from "@/components/routines/new-routine-page";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { proactiveKeys } from "@/lib/proactive";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/** The New routine screen: what it shows, and the writes it makes when submitted. */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const channel = (id: string, name: string, agentIds: string[]) => ({
  id,
  name,
  agentIds,
  active: true,
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-09T10:00:00Z",
  pinned: false,
  lastReadAt: null,
});

type Write = [method: string, path: string, body: unknown];
const recorded: Write[] = [];

/** The non-GET calls made since `serving()`, as `[method, path, body]`. */
function writes(): Write[] {
  return recorded;
}

/** What `GET /api/proactive/settings` answers now; `serving()` sets it, a test may change it later. */
let proactiveAnswer: unknown;

/** Answers what the page reads and records and answers what it writes. */
/** What `GET /api/proactive/readable` says the Bot can read, unless a case says otherwise. */
let readableAnswer: { apps: string[]; page: boolean } = {
  apps: ["Gmail"],
  page: true,
};

function serving({
  proactive = { allowed: true, settings: [] } as unknown,
  readable = { apps: ["Gmail"], page: true },
  routines = () => Response.json({ routine: { id: "r1" } }, { status: 201 }),
  goalDeletes = true,
  edition = "team",
}: {
  /** What `GET /api/capabilities` says this deployment is. */
  edition?: "team" | "personal";
  proactive?: unknown;
  /** How `POST /api/routines` answers. */
  routines?: () => Response | Promise<Response>;
  /** Whether `DELETE /api/responsibilities/g1` succeeds. When it fails, a refused schedule keeps the goal. */
  goalDeletes?: boolean;
  /** What a check-in for the chosen Bot could read. */
  readable?: { apps: string[]; page: boolean };
} = {}) {
  recorded.length = 0;
  readableAnswer = readable;
  proactiveAnswer = proactive;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      recorded.push([
        method,
        url,
        typeof init?.body === "string" ? JSON.parse(init.body) : null,
      ]);
      if (method === "POST" && url === "/api/channels")
        return Response.json({ channel: { id: "new-conversation" } });
      if (method === "POST" && url === "/api/routines") return routines();
      if (
        method === "DELETE" &&
        url === "/api/responsibilities/g1" &&
        !goalDeletes
      )
        return Response.json({ error: "Unavailable" }, { status: 503 });
      if (method === "POST" && url === "/api/responsibilities")
        return Response.json({ responsibility: { id: "g1", title: "Goal" } });
      return Response.json({ ok: true });
    }
    if (url.startsWith("/api/agents"))
      return Response.json({
        agents: [
          { id: "bot-1", name: "Bot One" },
          { id: "bot-2", name: "Bot Two" },
        ],
      });
    if (url.startsWith("/api/channels"))
      return Response.json({
        channels: [channel("c1", "Bot One", ["bot-1"])],
        nextCursor: null,
      });
    if (url === "/api/proactive/settings")
      return Response.json(proactiveAnswer);
    if (url === "/api/capabilities") return Response.json({ edition });
    if (url.startsWith("/api/proactive/readable"))
      return Response.json(readableAnswer);
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** The router of the last `draw()`, to read where a save went. */
let router: { state: { location: { pathname: string } } };

function draw({ preset = true } = {}) {
  router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () =>
        preset ? (
          <NewRoutinePage agentId="bot-1" channelId="c1" />
        ) : (
          <NewRoutinePage />
        ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the default answers make a routine", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Send me a summary of yesterday's new leads",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/routines",
  ]);
});

test("an outcome on a schedule makes a goal and its routine", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  await settleReactWork();
  const calls = writes();
  expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/responsibilities",
    "POST /api/routines",
  ]);
  expect(calls[0][2]).toMatchObject({
    endsWhenMet: true,
    successCriteria: "The report has a source link.",
  });
  expect(calls[1][2]).toMatchObject({ goalId: "g1" });
});

test("there is no kind to pick", async () => {
  serving();
  const view = draw();
  await view.findByLabelText("What to do");
  const user = userEvent.setup({ document });
  const kind = /^(Goal|Check-in)$/;
  // A closed Select draws no options, so open each one and look inside.
  for (const box of view.getAllByRole("combobox")) {
    await user.click(box);
    await view.findAllByRole("option");
    expect(view.queryAllByRole("option", { name: kind })).toHaveLength(0);
    await user.keyboard("{Escape}");
  }
  expect(view.queryAllByRole("menuitem", { name: kind })).toHaveLength(0);
  expect(view.queryAllByRole("button", { name: kind })).toHaveLength(0);
  expect(view.queryByRole("radio", { name: "Goal" })).toBeNull();
  expect(view.queryByText("Goal", { exact: true })).toBeNull();
  expect(view.queryByText("Check-in", { exact: true })).toBeNull();
  expect(view.queryByRole("radio", { name: "Check-in" })).toBeNull();
});

/** Opens the Select labelled `label` and picks `option`. */
async function choose(
  view: ReturnType<typeof draw>,
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(await view.findByLabelText(label));
  await user.click(await view.findByRole("option", { name: option }));
}

test("When something happens asks for a source and an event", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Triage the new issue",
  );
  await choose(view, user, "Starts", "When something happens");
  expect(await view.findByLabelText("Source")).toBeTruthy();
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(await view.findByText("Say which event starts it.")).toBeTruthy();
  expect(
    (await view.findByLabelText("Event")).getAttribute("aria-invalid"),
  ).toBe("true");
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("the personal edition, which has no Slack, offers no Slack event", async () => {
  for (const edition of ["team", "personal"] as const) {
    serving({ edition });
    const view = draw();
    const user = userEvent.setup({ document });
    await choose(view, user, "Starts", "When something happens");
    await waitFor(() =>
      expect(
        queryClient.getQueryState(deploymentCapabilitiesQueryOptions().queryKey)
          ?.status,
      ).toBe("success"),
    );
    await user.click(await view.findByLabelText("Source"));
    expect(await view.findByRole("option", { name: "GitHub" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Slack" }) !== null).toBe(
      edition === "team",
    );
    view.unmount();
    queryClient.clear();
  }
});

test("When something happens makes a goal with that subscription", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Triage the new issue",
  );
  await choose(view, user, "Starts", "When something happens");
  await user.type(await view.findByLabelText("Event"), "issues.opened");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  const calls = writes();
  expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/responsibilities",
  ]);
  expect(calls[0][2]).toMatchObject({
    subscriptions: [{ source: "github", eventType: "issues.opened" }],
    recurring: true,
  });
});

test("Now, once makes a goal and runs it", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await choose(view, user, "Starts", "Now, once");
  expect(view.queryByLabelText("When")).toBeNull();
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/responsibilities",
    "POST /api/responsibilities/g1/run",
  ]);
});

test("When it's done says when a one-off is done", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await view.findByLabelText("What to do");
  await choose(view, user, "Starts", "Now, once");
  expect(
    await view.findByText(
      "Optional. Leave it empty and it is done when the work is.",
    ),
  ).toBeTruthy();
});

test("a hidden event does not block a schedule", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await choose(view, user, "Starts", "When something happens");
  await user.type(await view.findByLabelText("Event"), "a".repeat(129));
  await choose(view, user, "Starts", "On a schedule");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/routines",
  ]);
});

test("Only tell you offers a schedule only, and no outcome", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Watch for unanswered customer emails",
  );
  await choose(view, user, "It should", "Only tell you");
  expect(
    await view.findByText(
      "It reads and raises what needs you. It changes nothing.",
    ),
  ).toBeTruthy();
  expect(await view.findByLabelText("How often")).toBeTruthy();
  expect(view.queryByLabelText("Starts")).toBeNull();
  expect(view.queryByText("When something happens")).toBeNull();
  expect(view.queryByText("Now, once")).toBeNull();
  expect(view.queryByLabelText("Done when (optional)")).toBeNull();
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  const calls = writes();
  expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/proactive/settings?refuseExisting=true",
  ]);
  expect(calls[0][2]).toMatchObject({
    agentId: "bot-1",
    focus: "Watch for unanswered customer emails",
    intervalMinutes: 1440,
  });
  // No conversation is made or named for it: a check-in belongs to its Bot.
  expect(calls[0][2]).not.toHaveProperty("channelId");
});

test("Only tell you asks for no conversation, and says where what it finds shows", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  expect(await view.findByLabelText("Posts in")).toBeTruthy();
  await choose(view, user, "It should", "Only tell you");
  await waitFor(() => expect(view.queryByLabelText("Posts in")).toBeNull());
  expect(
    view.getByText("What it finds shows under Needs you on Bots."),
  ).toBeTruthy();
  // Name stays: it is what the Routines page calls it.
  expect(view.getByLabelText("Name")).toBeTruthy();
});

test("How often sets the interval", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await choose(view, user, "How often", "Every 4 hours");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes()[0][2]).toMatchObject({ intervalMinutes: 240 });
});

test("a long instruction that only tells you is refused on What to do", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await choose(view, user, "It should", "Only tell you");
  await user.type(await view.findByLabelText("What to do"), "a".repeat(1001));
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(
    await view.findByText(
      "Keep it under 1000 characters when it only tells you.",
    ),
  ).toBeTruthy();
  expect(
    (await view.findByLabelText("What to do")).getAttribute("aria-invalid"),
  ).toBe("true");
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("Only tell you is absent when an admin turned check-ins off", async () => {
  serving({ proactive: { allowed: false, settings: [] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  // Wait for the check-ins answer itself: absence is also what the page shows while it loads.
  await waitFor(() =>
    expect(queryClient.getQueryState(proactiveKeys.settings)?.status).toBe(
      "success",
    ),
  );
  await settleReactWork();
  expect(view.queryByLabelText("It should")).toBeNull();
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/routines",
  ]);
});

/** What It should says when Only tell you was picked and an admin then turned check-ins off. */
const TELL_OFF =
  "An admin turned check-ins off, so it can't only tell you. Choose Act for you to go on.";

/**
 * An admin turns check-ins off while the form is open; the next read says so. Only the served
 * answer changes: the write log keeps what was written before, so a test can check all of it.
 */
async function checkInsTurnOff(settings: unknown[] = []) {
  proactiveAnswer = { allowed: false, settings };
  await queryClient.refetchQueries({ queryKey: proactiveKeys.settings });
}

test("a stale Only tell you is held until the person chooses", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await choose(view, user, "It should", "Only tell you");
  expect(await view.findByLabelText("How often")).toBeTruthy();
  await checkInsTurnOff();
  // It should stays, still says what was picked, and says why it can't go on.
  expect(await view.findByText(TELL_OFF)).toBeTruthy();
  const does = view.getByLabelText("It should");
  expect(does.textContent).toContain("Only tell you");
  expect(does.getAttribute("aria-invalid")).toBe("true");
  // It doesn't turn into an acting routine on its own.
  expect(view.queryByLabelText("Starts")).toBeNull();
  expect(view.queryByLabelText("Done when (optional)")).toBeNull();
  // Create can still be pressed: it writes nothing, and takes the person to It should.
  await user.click(view.getByRole("button", { name: "Create routine" }));
  await settleReactWork();
  expect(writes()).toEqual([]);
  expect(document.activeElement).toBe(does);
  // Only tell you can't be chosen again.
  await user.click(does);
  const tell = await view.findByRole("option", { name: "Only tell you" });
  expect(tell.getAttribute("aria-disabled")).toBe("true");
  await user.click(tell);
  await user.keyboard("{Escape}");
  expect(await view.findByText(TELL_OFF)).toBeTruthy();
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("choosing Act for you after check-ins are off is checked as acting", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Triage the new issue",
  );
  await choose(view, user, "Starts", "When something happens");
  await choose(view, user, "It should", "Only tell you");
  await checkInsTurnOff();
  await view.findByText(TELL_OFF);
  await choose(view, user, "It should", "Act for you");
  await waitFor(() => expect(view.queryByText(TELL_OFF)).toBeNull());
  // Acting is the only choice left, so the picker goes, as it does with check-ins off.
  await waitFor(() => expect(view.queryByLabelText("It should")).toBeNull());
  expect(await view.findByLabelText("Starts")).toBeTruthy();
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(await view.findByText("Say which event starts it.")).toBeTruthy();
  await settleReactWork();
  expect(writes()).toEqual([]);
  await user.type(await view.findByLabelText("Event"), "issues.opened");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/responsibilities",
  ]);
});

test("switching back to Act for you brings Starts back", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await view.findByLabelText("What to do");
  await choose(view, user, "It should", "Only tell you");
  await view.findByLabelText("How often");
  expect(view.queryByLabelText("Starts")).toBeNull();
  await choose(view, user, "It should", "Act for you");
  expect(await view.findByLabelText("Starts")).toBeTruthy();
  expect(await view.findByLabelText("Done when (optional)")).toBeTruthy();
  expect(view.queryByLabelText("How often")).toBeNull();
});

/**
 * A Bot's default check-in, as `GET /api/proactive/settings` sends it: no Name, no link. OpenBot
 * seeds one for a Bot (`server/src/memory/defaults.ts`).
 */
const unnamedCheckIn = {
  id: "s1",
  agentId: "bot-1",
  channelId: "c0",
  focus: "",
  subject: "",
  sourceLink: null,
  enabled: true,
  intervalMinutes: 60,
  nextRunAt: "2026-11-10T10:00:00Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  lastRun: null,
};

/** A check-in the Bot already has on what the tests below type: "Watch my inbox". */
const watchingInbox = { ...unnamedCheckIn, subject: "Watch my inbox" };

test("an unnamed Only tell you is made beside the Bot's default check-in, named for what it does", async () => {
  serving({ proactive: { allowed: true, settings: [unnamedCheckIn] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Watch   my inbox\nfor invoices",
  );
  await choose(view, user, "It should", "Only tell you");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(view.queryByText(/This Bot already checks in on this/)).toBeNull();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/proactive/settings?refuseExisting=true",
  ]);
  expect(writes()[0][2]).toMatchObject({
    focus: "Watch   my inbox\nfor invoices",
    subject: "Watch my inbox for invoices",
  });
});

test("Only tell you does not take over a check-in the Bot already has", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(
    await view.findByText(
      "This Bot already checks in on this. Give this one a different name, or change that one on its row.",
    ),
  ).toBeTruthy();
  expect(
    (await view.findByLabelText("Name")).getAttribute("aria-invalid"),
  ).toBe("true");
  await settleReactWork();
  expect(writes()).toEqual([]);
  // A Name of its own is another check-in, and the error goes with the old Name.
  await user.type(await view.findByLabelText("Name"), "Inbox");
  await waitFor(() =>
    expect(
      view.queryByText(
        "This Bot already checks in on this. Give this one a different name, or change that one on its row.",
      ),
    ).toBeNull(),
  );
});

test("a named Only tell you is made beside it", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await user.type(await view.findByLabelText("Name"), "Inbox");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/proactive/settings?refuseExisting=true",
  ]);
  expect(writes()[0][2]).toMatchObject({ subject: "Inbox" });
});

test("acting instead lets that Name through", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await view.findByText(/This Bot already checks in on this/);
  await choose(view, user, "It should", "Act for you");
  await waitFor(() =>
    expect(view.queryByText(/This Bot already checks in on this/)).toBeNull(),
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/routines",
  ]);
});

test("a stale Name error goes once check-ins are off", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await view.findByText(/This Bot already checks in on this/);
  await checkInsTurnOff([watchingInbox]);
  // No check-in can be made now, so Name has nothing to clash with.
  await waitFor(() =>
    expect(view.queryByText(/This Bot already checks in on this/)).toBeNull(),
  );
  expect(view.getByLabelText("Name").getAttribute("aria-invalid")).not.toBe(
    "true",
  );
  expect(await view.findByText(TELL_OFF)).toBeTruthy();
  await choose(view, user, "It should", "Act for you");
  await waitFor(() =>
    expect(view.container.querySelector('[aria-invalid="true"]')).toBeNull(),
  );
  await user.click(view.getByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/routines",
  ]);
});

test("after a partial save, Create routine gives way to Go to Routines", async () => {
  serving({
    routines: () =>
      Response.json(
        { error: "You have 20 routines switched on." },
        { status: 400 },
      ),
    goalDeletes: false,
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(
    await view.findByText(
      "It's saved but paused, on the Routines page. Its schedule was refused. You have 20 routines switched on.",
    ),
  ).toBeTruthy();
  await settleReactWork();
  expect(view.queryByRole("button", { name: "Create routine" })).toBeNull();
  // A link drawn as a button, as Cancel is.
  const goTo = view.getByRole("button", { name: "Go to Routines" });
  expect(goTo.tagName).toBe("A");
  expect(goTo.getAttribute("href")).toBe("/bots/bot-1/routines");
});

test("a refused schedule takes the goal back, says why, and Create works again", async () => {
  let refuse = true;
  serving({
    routines: () =>
      refuse
        ? Response.json(
            { error: "You have 20 routines switched on." },
            { status: 400 },
          )
        : Response.json({ routine: { id: "r1" } }, { status: 201 }),
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(
    await view.findByText("You have 20 routines switched on."),
  ).toBeTruthy();
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/responsibilities",
    "POST /api/routines",
    "DELETE /api/responsibilities/g1",
  ]);
  // Nothing was kept, so nothing is locked: no Go to Routines, and Create is there to press again.
  expect(view.queryByRole("button", { name: "Go to Routines" })).toBeNull();
  refuse = false;
  await user.click(view.getByRole("button", { name: "Create routine" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/bot-1/routines"),
  );
});

test("the Routines back link waits while the routine is being created", async () => {
  let answer: (response: Response) => void = () => {};
  serving({
    routines: () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  });
  const view = draw();
  const user = userEvent.setup({ document });
  expect(
    (await view.findByRole("button", { name: "Routines" })).getAttribute(
      "href",
    ),
  ).toBe("/bots/bot-1/routines");
  await user.type(
    await view.findByLabelText("What to do"),
    "Send me a summary of yesterday's new leads",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() =>
    expect(
      writes().some(
        ([method, path]) => method === "POST" && path === "/api/routines",
      ),
    ).toBe(true),
  );
  const back = view.getByRole("button", { name: "Routines" });
  expect(back.hasAttribute("disabled")).toBe(true);
  expect(back.hasAttribute("href")).toBe(false);
  answer(Response.json({ routine: { id: "r1" } }, { status: 201 }));
  await settleReactWork();
});

test("Cancel waits while the routine is being created", async () => {
  let answer: (response: Response) => void = () => {};
  serving({
    routines: () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Send me a summary of yesterday's new leads",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() =>
    expect(
      writes().some(
        ([method, path]) => method === "POST" && path === "/api/routines",
      ),
    ).toBe(true),
  );
  expect(
    view.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
  ).toBe(true);
  answer(Response.json({ routine: { id: "r1" } }, { status: 201 }));
  await settleReactWork();
});

test("after a partial save, a submit does not make a second goal", async () => {
  serving({
    routines: () =>
      Response.json(
        { error: "You have 20 routines switched on." },
        { status: 400 },
      ),
    goalDeletes: false,
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await view.findByRole("button", { name: "Go to Routines" });
  await settleReactWork();
  // No submit button is left, so Enter alone never submits. Submit the form directly, which is
  // what reaches the guard in onSubmit.
  const form = view.container.querySelector("form");
  if (!form) throw new Error("The form is missing.");
  fireEvent.submit(form);
  await settleReactWork();
  expect(
    writes().filter(
      ([method, path]) => `${method} ${path}` === "POST /api/responsibilities",
    ),
  ).toHaveLength(1);
});

/** Fills What to do, picks Bot Two in the Bot picker, and presses Create routine. */
async function saveForBotTwo(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Send me a summary of yesterday's new leads",
  );
  await choose(view, user, "Bot", "Bot Two");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
}

test("saving for another Bot lands on that Bot's Routines", async () => {
  serving();
  const view = draw();
  await saveForBotTwo(view);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/bot-2/routines"),
  );
});

test("saving for the Bot it was opened from lands on that Bot's Routines", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Send me a summary of yesterday's new leads",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/bots/bot-1/routines"),
  );
});

test("after a partial save, Go to Routines points at the chosen Bot", async () => {
  serving({
    routines: () =>
      Response.json(
        { error: "You have 20 routines switched on." },
        { status: 400 },
      ),
    goalDeletes: false,
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await choose(view, user, "Bot", "Bot Two");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  const goTo = await view.findByRole("button", { name: "Go to Routines" });
  expect(goTo.getAttribute("href")).toBe("/bots/bot-2/routines");
});

test("saving from the Routines page stays there whichever Bot was picked", async () => {
  serving();
  const view = draw({ preset: false });
  await saveForBotTwo(view);
  await waitFor(() => expect(router.state.location.pathname).toBe("/routines"));
});

test("from the Routines page, Go to Routines points at it", async () => {
  serving({
    routines: () =>
      Response.json(
        { error: "You have 20 routines switched on." },
        { status: 400 },
      ),
    goalDeletes: false,
  });
  const view = draw({ preset: false });
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await choose(view, user, "Bot", "Bot Two");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  const goTo = await view.findByRole("button", { name: "Go to Routines" });
  expect(goTo.getAttribute("href")).toBe("/routines");
});

/** Saves a goal whose schedule is refused, and returns the Go to Routines link that replaces Create routine. */
async function partialSave(
  view: ReturnType<typeof draw>,
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  return view.findByRole("button", { name: "Go to Routines" });
}

const refusedSchedule = () =>
  Response.json(
    { error: "You have 20 routines switched on." },
    { status: 400 },
  );

test("after a partial save, every field is disabled", async () => {
  serving({ routines: refusedSchedule, goalDeletes: false });
  const view = draw();
  const user = userEvent.setup({ document });
  await partialSave(view, user);
  await settleReactWork();
  const isDisabled = (element: Element) =>
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("data-disabled");
  const fields = [
    ...view.getAllByRole("combobox"),
    ...view.getAllByRole("textbox"),
    view.getByLabelText("Time"),
  ];
  // Bot, It should, Starts, When, Posts in; What to do, Done when, Name; Time.
  expect(fields.length).toBeGreaterThanOrEqual(9);
  for (const field of fields) expect(isDisabled(field)).toBe(true);
  // The Bot picker can't be changed, so the Go to Routines link can't drift from the saved Bot.
  await user.click(view.getByLabelText("Bot"));
  expect(view.queryByRole("option", { name: "Bot Two" })).toBeNull();
});

test("after a partial save, Go to Routines stays on the Bot it was saved for", async () => {
  serving({ routines: refusedSchedule, goalDeletes: false });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Write the quarterly report",
  );
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a source link.",
  );
  await choose(view, user, "Bot", "Bot Two");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await view.findByRole("button", { name: "Go to Routines" });
  await settleReactWork();
  // The picker is locked, so the Bot can't be changed to drift the link away from what was saved.
  const picker = view.getByLabelText("Bot");
  expect(picker.hasAttribute("disabled")).toBe(true);
  await user.click(picker);
  await settleReactWork();
  expect(view.queryByRole("option", { name: "Bot One" })).toBeNull();
  expect(view.getByLabelText("Bot").textContent).toContain("Bot Two");
  expect(
    view.getByRole("button", { name: "Go to Routines" }).getAttribute("href"),
  ).toBe("/bots/bot-2/routines");
});

test("after a partial save, Go to Routines is the only way out in the body", async () => {
  serving({ routines: refusedSchedule, goalDeletes: false });
  const view = draw();
  const user = userEvent.setup({ document });
  await partialSave(view, user);
  expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(view.getAllByRole("button", { name: "Go to Routines" })).toHaveLength(
    1,
  );
});

/**
 * Cross-field rules. Each rule below reads answers other than its own field, so its error has to
 * follow those answers: gone when they change to ones that allow the value, back when they change
 * to ones that do not.
 */

const NO_MORE_THAN_1000 =
  "Keep it under 1000 characters when it only tells you.";
const NO_MORE_THAN_2000 = "Keep it to 2000 characters or fewer.";

/** Replaces the text of a field. */
async function setValue(element: HTMLElement, value: string) {
  // No wait between keystrokes: 2000 of them at the default pace outlast the test's timeout.
  const user = userEvent.setup({ document, delay: null });
  await user.click(element);
  await user.keyboard("{Control>}a{/Control}{Delete}");
  if (value) await user.type(element, value);
}

/** Empties the Time input, which `user.clear` leaves alone: select it all and delete. */
async function clearTime(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document, delay: null });
  await user.click(await view.findByLabelText("Time"));
  await user.keyboard("{Control>}a{/Control}{Delete}");
}

async function createButton(view: ReturnType<typeof draw>) {
  return (await view.findByRole("button", {
    name: "Create routine",
  })) as HTMLButtonElement;
}

/** Presses Create and waits for the refusal to be drawn. Nothing is written. */
async function refuse(
  view: ReturnType<typeof draw>,
  user: ReturnType<typeof userEvent.setup>,
  message: string,
) {
  await user.click(await createButton(view));
  await view.findByText(message);
  await settleReactWork();
  expect(writes()).toEqual([]);
}

/** Says `message` is gone, and no field says anything: Create would go on. */
async function expectCleared(view: ReturnType<typeof draw>, message: string) {
  await waitFor(() => expect(view.queryByText(message)).toBeNull());
  await waitFor(() =>
    expect(view.container.querySelector('[aria-invalid="true"]')).toBeNull(),
  );
}

test("the instruction limit follows It should: Act for you clears the Only tell you limit", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await choose(view, user, "It should", "Only tell you");
  await setValue(await view.findByLabelText("What to do"), "a".repeat(1001));
  await refuse(view, user, NO_MORE_THAN_1000);
  await choose(view, user, "It should", "Act for you");
  await expectCleared(view, NO_MORE_THAN_1000);
});

test("the instruction limit follows It should: Only tell you tightens it", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await setValue(await view.findByLabelText("What to do"), "a".repeat(1001));
  expect(view.queryByText(NO_MORE_THAN_1000)).toBeNull();
  await choose(view, user, "It should", "Only tell you");
  expect(await view.findByText(NO_MORE_THAN_1000)).toBeTruthy();
});

test("the instruction limit follows Done when: filling it lifts the routine limit", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await setValue(await view.findByLabelText("What to do"), "a".repeat(2001));
  await refuse(view, user, NO_MORE_THAN_2000);
  await user.type(
    await view.findByLabelText("Done when (optional)"),
    "The report has a link.",
  );
  await expectCleared(view, NO_MORE_THAN_2000);
});

test("the instruction limit follows Done when: emptying it brings the routine limit back", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await setValue(await view.findByLabelText("What to do"), "a".repeat(2001));
  await setValue(await view.findByLabelText("Done when (optional)"), "A link.");
  expect(view.queryByText(NO_MORE_THAN_2000)).toBeNull();
  await setValue(await view.findByLabelText("Done when (optional)"), "");
  expect(await view.findByText(NO_MORE_THAN_2000)).toBeTruthy();
  await user.click(await createButton(view));
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("the instruction limit follows Starts: an event lifts the routine limit", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await setValue(await view.findByLabelText("What to do"), "a".repeat(2001));
  await refuse(view, user, NO_MORE_THAN_2000);
  await choose(view, user, "Starts", "When something happens");
  await setValue(await view.findByLabelText("Event"), "issues.opened");
  await expectCleared(view, NO_MORE_THAN_2000);
});

test("the instruction limit follows Starts: Now, once lifts the routine limit", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await setValue(await view.findByLabelText("What to do"), "a".repeat(2001));
  await refuse(view, user, NO_MORE_THAN_2000);
  await choose(view, user, "Starts", "Now, once");
  await expectCleared(view, NO_MORE_THAN_2000);
});

test("the instruction limit follows Starts: a schedule tightens an event's limit", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await choose(view, user, "Starts", "When something happens");
  await setValue(await view.findByLabelText("What to do"), "a".repeat(2001));
  expect(view.queryByText(NO_MORE_THAN_2000)).toBeNull();
  await choose(view, user, "Starts", "On a schedule");
  expect(await view.findByText(NO_MORE_THAN_2000)).toBeTruthy();
});

test("Time follows When: Every hour does not ask for one", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await clearTime(view);
  await refuse(view, user, "Choose a time.");
  await choose(view, user, "When", "Every hour");
  await expectCleared(view, "Choose a time.");
});

test("Time follows When: Every day asks for it again", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await clearTime(view);
  await refuse(view, user, "Choose a time.");
  await choose(view, user, "When", "Every hour");
  await expectCleared(view, "Choose a time.");
  await choose(view, user, "When", "Every day");
  expect(await view.findByText("Choose a time.")).toBeTruthy();
});

test("Time follows Starts: an event does not ask for one", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await clearTime(view);
  await refuse(view, user, "Choose a time.");
  await choose(view, user, "Starts", "When something happens");
  await setValue(await view.findByLabelText("Event"), "issues.opened");
  await expectCleared(view, "Choose a time.");
});

test("Time follows It should: Only tell you does not ask for one", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await clearTime(view);
  await refuse(view, user, "Choose a time.");
  await choose(view, user, "It should", "Only tell you");
  await expectCleared(view, "Choose a time.");
});

test("Event follows Starts: a schedule does not ask for one", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await choose(view, user, "Starts", "When something happens");
  await refuse(view, user, "Say which event starts it.");
  await choose(view, user, "Starts", "On a schedule");
  await expectCleared(view, "Say which event starts it.");
});

test("Event follows It should: Only tell you does not ask for one", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await choose(view, user, "Starts", "When something happens");
  await refuse(view, user, "Say which event starts it.");
  await choose(view, user, "It should", "Only tell you");
  await expectCleared(view, "Say which event starts it.");
});

test("Done when follows It should: Only tell you does not measure it", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await setValue(
    await view.findByLabelText("Done when (optional)"),
    "a".repeat(3001),
  );
  await refuse(view, user, "Keep it under 3000 characters.");
  await choose(view, user, "It should", "Only tell you");
  await expectCleared(view, "Keep it under 3000 characters.");
});

test("Name follows Bot: another Bot has no such check-in", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await refuse(view, user, SAME_CHECK_IN_TEXT);
  await choose(view, user, "Bot", "Bot Two");
  await expectCleared(view, SAME_CHECK_IN_TEXT);
});

const SAME_CHECK_IN_TEXT =
  "This Bot already checks in on this. Give this one a different name, or change that one on its row.";

/**
 * A field's message is what the answers say now, shown once the person worked on that field or
 * pressed Create: not what the last check that happened to run said.
 */

const SAY_WHAT = "Say what the Bot should do.";
const SAY_WHICH_EVENT = "Say which event starts it.";
const NAME_TOO_LONG = "Keep the name under 100 characters.";
const DONE_WHEN_TOO_LONG = "Keep it under 3000 characters.";

/** Says `message` is still drawn after an answer it does not depend on changed. */
async function expectStill(view: ReturnType<typeof draw>, message: string) {
  await settleReactWork();
  expect(view.queryByText(message)).toBeTruthy();
}

test("Time drawn again after Every hour clears its message once a time is chosen", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await clearTime(view);
  await refuse(view, user, "Choose a time.");
  await choose(view, user, "When", "Every hour");
  await expectCleared(view, "Choose a time.");
  await choose(view, user, "When", "Every day");
  expect(await view.findByText("Choose a time.")).toBeTruthy();
  await user.type(await view.findByLabelText("Time"), "10:00");
  await expectCleared(view, "Choose a time.");
  await user.click(await createButton(view));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  await settleReactWork();
  expect(writes().map(([method, path]) => `${method} ${path}`)).toEqual([
    "POST /api/routines",
  ]);
});

test("Event drawn again after a schedule clears its message once an event is named", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await choose(view, user, "Starts", "When something happens");
  await refuse(view, user, SAY_WHICH_EVENT);
  await choose(view, user, "Starts", "On a schedule");
  await expectCleared(view, SAY_WHICH_EVENT);
  await choose(view, user, "Starts", "When something happens");
  expect(await view.findByText(SAY_WHICH_EVENT)).toBeTruthy();
  await user.type(await view.findByLabelText("Event"), "issues.opened");
  await expectCleared(view, SAY_WHICH_EVENT);
});

test("Done when drawn again after Only tell you clears its message once it is short enough", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await setValue(
    await view.findByLabelText("Done when (optional)"),
    "a".repeat(3001),
  );
  await refuse(view, user, DONE_WHEN_TOO_LONG);
  await choose(view, user, "It should", "Only tell you");
  await expectCleared(view, DONE_WHEN_TOO_LONG);
  await choose(view, user, "It should", "Act for you");
  expect(await view.findByText(DONE_WHEN_TOO_LONG)).toBeTruthy();
  await setValue(await view.findByLabelText("Done when (optional)"), "A link.");
  await expectCleared(view, DONE_WHEN_TOO_LONG);
});

test("an Event nobody worked on says nothing when Starts comes back to it", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await choose(view, user, "Starts", "When something happens");
  await choose(view, user, "Starts", "On a schedule");
  await choose(view, user, "Starts", "When something happens");
  await settleReactWork();
  expect(view.queryByText(SAY_WHICH_EVENT)).toBeNull();
  expect(
    (await view.findByLabelText("Event")).getAttribute("aria-invalid"),
  ).not.toBe("true");
  expect(view.container.querySelector('[aria-invalid="true"]')).toBeNull();
});

test("an empty What to do keeps its message while other answers change", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await refuse(view, user, SAY_WHAT);
  await choose(view, user, "Starts", "Now, once");
  await expectStill(view, SAY_WHAT);
  await user.type(await view.findByLabelText("Done when (optional)"), "Done.");
  await expectStill(view, SAY_WHAT);
  await choose(view, user, "It should", "Only tell you");
  await expectStill(view, SAY_WHAT);
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await expectCleared(view, SAY_WHAT);
});

test("a long Name keeps its message when the Bot changes", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send it");
  await setValue(await view.findByLabelText("Name"), "a".repeat(101));
  await refuse(view, user, NAME_TOO_LONG);
  await choose(view, user, "Bot", "Bot Two");
  await expectStill(view, NAME_TOO_LONG);
  await setValue(await view.findByLabelText("Name"), "Leads");
  await expectCleared(view, NAME_TOO_LONG);
});

test("a Name that still clashes keeps its message when the Bot or It should changes", async () => {
  serving({
    proactive: {
      allowed: true,
      settings: [
        watchingInbox,
        { ...watchingInbox, id: "s2", agentId: "bot-2" },
      ],
    },
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await refuse(view, user, SAME_CHECK_IN_TEXT);
  // Bot Two has an unnamed check-in too.
  await choose(view, user, "Bot", "Bot Two");
  await expectStill(view, SAME_CHECK_IN_TEXT);
  await choose(view, user, "It should", "Act for you");
  await expectCleared(view, SAME_CHECK_IN_TEXT);
  await choose(view, user, "It should", "Only tell you");
  expect(await view.findByText(SAME_CHECK_IN_TEXT)).toBeTruthy();
  await user.type(await view.findByLabelText("Name"), "Inbox");
  await expectCleared(view, SAME_CHECK_IN_TEXT);
});

/** An admin turns check-ins back on; the next read says so. */
async function checkInsTurnOn(settings: unknown[] = []) {
  proactiveAnswer = { allowed: true, settings };
  await queryClient.refetchQueries({ queryKey: proactiveKeys.settings });
}

test("It should follows check-ins: turned back on, Only tell you can go on", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await checkInsTurnOff();
  await view.findByText(TELL_OFF);
  await checkInsTurnOn();
  await expectCleared(view, TELL_OFF);
});

test("Name follows check-ins: turned back on, the clash is back", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await refuse(view, user, SAME_CHECK_IN_TEXT);
  await checkInsTurnOff([watchingInbox]);
  await waitFor(() => expect(view.queryByText(SAME_CHECK_IN_TEXT)).toBeNull());
  await checkInsTurnOn([watchingInbox]);
  expect(await view.findByText(SAME_CHECK_IN_TEXT)).toBeTruthy();
});

test("an uncertain routine save locks the form and links to the chosen Bot", async () => {
  serving({
    routines: () => Response.json({ error: "Unavailable" }, { status: 503 }),
  });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Send the digest");
  await choose(view, user, "Bot", "Bot Two");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  const goTo = await view.findByRole("button", { name: "Go to Routines" });
  expect(goTo.getAttribute("href")).toBe("/bots/bot-2/routines");
  expect(view.getByLabelText("Bot").hasAttribute("disabled")).toBe(true);
  expect(view.queryByRole("button", { name: "Create routine" })).toBeNull();
  expect(
    writes().some(
      ([method, path]) =>
        method === "DELETE" && path.startsWith("/api/channels/"),
    ),
  ).toBe(false);
  expect(view.getByRole("alert").textContent).toContain("may have been saved");
});

/*
 * Create stays enabled while a message shows. A disabled Create said nothing about why, and the
 * focus it held was lost: pressing it moves focus to the first field with a message, each message is
 * tied to its control, and after a partial save focus moves to Go to Routines, which replaces it.
 */

test("Create stays enabled with a message showing, and pressing it goes to the first field that has one", async () => {
  serving();
  const view = draw();
  const user = userEvent.setup({ document });
  await clearTime(view);
  const create = await createButton(view);
  await user.click(create);
  await view.findByText(SAY_WHAT);
  await view.findByText("Choose a time.");
  await settleReactWork();
  expect(writes()).toEqual([]);
  expect(create.disabled).toBe(false);
  // What to do comes first on the page, so it is where the person is taken.
  const instruction = view.getByLabelText("What to do");
  expect(document.activeElement).toBe(instruction);
  // Fixed, the next press goes to the one left.
  await user.type(instruction, "Send it");
  await user.click(await createButton(view));
  await settleReactWork();
  expect(document.activeElement).toBe(view.getByLabelText("Time"));
  expect(writes()).toEqual([]);
});

test("each message is tied to its control", async () => {
  serving({ proactive: { allowed: true, settings: [watchingInbox] } });
  const view = draw();
  const user = userEvent.setup({ document });
  await clearTime(view);
  await user.click(await createButton(view));
  const describedBy = (label: string, message: string) => {
    const ids = (
      view.getByLabelText(label).getAttribute("aria-describedby") ?? ""
    ).split(" ");
    const text = ids
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(text).toContain(message);
  };
  await view.findByText(SAY_WHAT);
  describedBy("What to do", SAY_WHAT);
  describedBy("Time", "Choose a time.");
  // On a field whose message comes from what the Bot already has.
  await user.type(view.getByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await view.findByText(SAME_CHECK_IN_TEXT);
  describedBy("Name", SAME_CHECK_IN_TEXT);
  // A field with nothing to say points at nothing.
  await user.type(view.getByLabelText("Name"), "Inbox");
  await waitFor(() =>
    expect(view.getByLabelText("Name").hasAttribute("aria-describedby")).toBe(
      false,
    ),
  );
});

test("after a partial save, focus moves to Go to Routines", async () => {
  serving({ routines: refusedSchedule, goalDeletes: false });
  const view = draw();
  const user = userEvent.setup({ document });
  const goTo = await partialSave(view, user);
  await waitFor(() => expect(document.activeElement).toBe(goTo));
});

/*
 * FOUND IN AN AUDIT: Only tell you made a check-in for a Bot that could read nothing, and it was
 * skipped on every run with nobody told. It watches says what it reads, and refuses what it can't.
 */
test("It watches says which apps it reads", async () => {
  serving({ readable: { apps: ["Gmail", "Notion"], page: true } });
  const view = draw();
  const user = userEvent.setup({ document });
  await choose(view, user, "It should", "Only tell you");
  expect(await view.findByText("It reads Gmail and Notion.")).toBeTruthy();
});

test("with no app it can read, Create routine is refused on It watches, and nothing is written", async () => {
  serving({ readable: { apps: [], page: true } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("What to do"), "Watch my inbox");
  await choose(view, user, "It should", "Only tell you");
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(
    await view.findByText(
      "This Bot can't read any app you've connected. Connect one in Connections, or choose a web page.",
    ),
  ).toBeTruthy();
  expect(
    (await view.findByLabelText("It watches")).getAttribute("aria-invalid"),
  ).toBe("true");
  await settleReactWork();
  expect(writes()).toEqual([]);
});

test("A web page asks for its address and sends it with what it watches", async () => {
  serving({ readable: { apps: [], page: true } });
  const view = draw();
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByLabelText("What to do"),
    "Tell me about new releases",
  );
  await choose(view, user, "It should", "Only tell you");
  await choose(view, user, "It watches", "A web page");
  expect(
    await view.findByText(
      "It reads this page each time and tells you when something there needs you.",
    ),
  ).toBeTruthy();
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  expect(
    await view.findByText("Enter the page's address, starting with https://."),
  ).toBeTruthy();
  await user.type(
    await view.findByLabelText("Page address"),
    "https://github.com/CopilotKit/openbot/releases",
  );
  await user.click(await view.findByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(writes()).not.toHaveLength(0));
  expect(writes()[0][2]).toMatchObject({
    watches: "page",
    sourceLink: "https://github.com/CopilotKit/openbot/releases",
  });
});

test("A web page stays listed but can't be chosen for a Bot with no web search", async () => {
  serving({ readable: { apps: ["Gmail"], page: false } });
  const view = draw();
  const user = userEvent.setup({ document });
  await choose(view, user, "It should", "Only tell you");
  await user.click(await view.findByLabelText("It watches"));
  const page = await view.findByRole("option", { name: /A web page/ });
  expect(page.getAttribute("aria-disabled")).toBe("true");
  expect(page.textContent).toContain("This Bot has no web search.");
});
