import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Composer } from "@/components/channels/composer/composer";
import { PlanBanner } from "@/components/layout/plan-banner";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { CardNeededDialog } from "@/components/plan/card-needed-dialog";
import { GoalPage } from "@/components/responsibilities/goal-page";
import { RoutinePage } from "@/components/routines/routine-page";
import type { OrganizationPlan } from "@/lib/api/generated/model";
import { stoppedReason } from "@/lib/copilot/stopped-turn";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { authKeys } from "@/lib/auth/queries";
import {
  forgetCardNeededRefusal,
  forgetTrialUsedUpAnnounced,
  hideCardNeeded,
  rememberTrialUsedUpAnnounced,
} from "@/lib/plan/card-needed";
import { planKeys } from "@/lib/plan/queries";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * OpenBot Cloud's free usage-based trial, where the person meets it: the Plan row in Settings shows
 * how much is used as a bar and a percentage, and once it is used up one dialog says so plainly,
 * with the size of the trial and the price, and opens in place of every AI action they try. Closing
 * it lasts until the next try. A refusal from the server (PLAN_REQUIRED, 402) opens it too, so an
 * action no screen checked first still says why. An admin gets the way to add a card, a member is
 * told who to ask.
 *
 * The app's own screens and its one query client, against a server answering at the API's
 * addresses: the plan read (getOrganizationPlan) as the spec words it, and every write recorded, so
 * "instead of calling the server" is a request that was never made.
 */

const ORG = "org_ana";
const ADD_CARD = `/api/auth/hosted/checkout?organizationId=${ORG}`;
const PLAN_PATH = `/api/v2/organizations/${ORG}/plan`;

let plan: OrganizationPlan;
/** What the server answers a write with: a run started, or refused for want of a plan. */
let refuseRuns = false;
/** While set, the plan read waits for it: a server slow to answer. */
let planHeld: Promise<void> | null = null;
const writes: string[] = [];

/** Ana, signed in, as the app has read her before any screen draws. */
function signedIn() {
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "ana",
    email: "ana@example.com",
    name: "Ana Lopez",
    role: "owner",
  });
}

const originalFetch = global.fetch;
let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(async () => {
  await settleReactWork();
  setCurrentOrganization(undefined);
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  queryClient.clear();
  forgetTrialUsedUpAnnounced();
  forgetCardNeededRefusal();
  hideCardNeeded();
  writes.length = 0;
  refuseRuns = false;
  planHeld = null;
  setCurrentOrganization(ORG);
  signedIn();
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.invalid/");
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push(`${method} ${url.pathname}`);
        if (refuseRuns)
          return Response.json(
            {
              type: "https://open.bot/errors/plan-required",
              title: "This organization needs a plan.",
              status: 402,
              detail:
                "You've used your free trial. Add a card to keep your Bots running for $5 a month for each member.",
              code: "PLAN_REQUIRED",
              addCardUrl: ADD_CARD,
            },
            {
              status: 402,
              headers: { "content-type": "application/problem+json" },
            },
          );
        return Response.json({ queued: true }, { status: 202 });
      }
      if (url.pathname === PLAN_PATH) {
        if (planHeld) await planHeld;
        return Response.json(plan);
      }
      // Every list a screen here reads, empty.
      return Response.json({
        members: [],
        invitations: [],
        runs: [],
        triggers: [],
        nextCursor: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  hideCardNeeded();
  await settleReactWork();
  global.fetch = originalFetch;
});

const usedUp = (admin: boolean): OrganizationPlan => ({
  required: true,
  status: "none",
  freeRunsUsedPercent: 100,
  freeRunsAllowance: 500,
  trialEndsAt: null,
  renewsAt: null,
  addCardUrl: admin ? ADD_CARD : null,
});

/** A CopilotKit employee past the free allowance, as the server answers: still free, never a card. */
const employeeUsedUp = (): OrganizationPlan => ({
  required: true,
  status: "free",
  freeRunsUsedPercent: 100,
  freeRunsAllowance: 500,
  copilotKitEmployee: true,
  trialEndsAt: null,
  renewsAt: null,
  addCardUrl: null,
});

const EMPLOYEE_LINE =
  "Free because you're a CopilotKit employee. Thanks, Uncle Atai!";
const SENTRY_ALT =
  "Sentry, a white golden retriever, sitting on a rock above a mountain meadow";

const routine: RoutineRecord = {
  id: "routine-1",
  botId: "bot-1",
  schedule: "Weekdays at 09:00",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  instruction: "Check the queue.",
  title: "Morning queue check",
  conversation: { id: "c1", name: null, title: "Queue", gone: false },
  enabled: true,
  nextRunAt: "2999-01-01T09:00:00.000Z",
  lastRun: null,
  goalId: null,
  createdAt: "2026-11-10T08:00:00Z",
};

const goal: ResponsibilityRecord = {
  id: "goal-1",
  botId: "bot-1",
  conversationId: "c1",
  threadId: "t1",
  title: "Watch the queue",
  instruction: "Tell me when the queue backs up.",
  successCriteria: "The queue is empty.",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  createdAt: "2026-11-10T10:00:00Z",
  updatedAt: "2026-11-10T10:00:00Z",
  completedAt: null,
};

/** A screen of the app with the one dialog the signed-in layout mounts beside it. */
function open(screen: ReactNode) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => (
          <>
            {screen}
            <CardNeededDialog />
          </>
        ),
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The plan as the app already read it, as it is by the time anybody presses anything. */
async function planRead() {
  await queryClient.fetchQuery({
    queryKey: planKeys.current(),
    queryFn: () => plan,
  });
}

const dialog = () => document.querySelector('[role="dialog"]');

/** Let the dialog's opening or closing finish, inside act, as its animation's updates need. */
async function settled() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });
}

/** Waits, inside act, for the dialog to open: the plan read it opens on answers on its own time. */
async function opened() {
  for (let tries = 0; tries < 40 && !dialog(); tries++) await settled();
  await settled();
  expect(dialog()).not.toBeNull();
}

async function dismiss() {
  const close = document.querySelector(
    '[data-slot="dialog-close"]',
  ) as HTMLElement;
  await act(async () => {
    fireEvent.click(close);
  });
  await settled();
  expect(dialog()).toBeNull();
}

test("on the free trial the Plan row shows how much is used, and once paid the plan", async () => {
  plan = {
    required: true,
    status: "free",
    freeRunsUsedPercent: 42,
    trialEndsAt: null,
    renewsAt: null,
    // Never sent while runs are left, even to an admin.
    addCardUrl: null,
  };
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [
      {
        id: ORG,
        slug: "ana",
        name: "Ana's organization",
        role: "owner",
        active: true,
        personal: true,
      },
    ],
    canCreate: true,
    currentId: ORG,
  });
  const view = open(<OrganizationSettingsPage />);

  const bar = await view.findByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("42");
  expect(bar.textContent).toContain("Free trial");
  expect(bar.textContent).toContain("42% used");
  // Never a count or a limit, and nothing to add while runs are left.
  expect(view.container.textContent).not.toMatch(/\b500\b|runs left/);
  expect(view.queryByRole("link", { name: "Add a card" })).toBeNull();
  expect(dialog()).toBeNull();
  cleanup();

  plan = {
    required: true,
    status: "active",
    trialEndsAt: null,
    renewsAt: "2026-12-20T12:00:00Z",
    addCardUrl: null,
  };
  await queryClient.invalidateQueries({ queryKey: planKeys.all });
  const paid = open(<OrganizationSettingsPage />);
  await paid.findByText(/^Active, renews /);
  expect(paid.queryByRole("progressbar")).toBeNull();
});

test("once the trial is used up, the dialog says so once, and then opens in place of every AI action", async () => {
  plan = usedUp(true);
  const sent: string[] = [];
  const view = open(
    <>
      <Composer
        compact
        initialValue="Summarize this week's signups"
        onSubmit={(draft) => {
          sent.push(draft.text);
        }}
      />
      <RoutinePage back={{ to: "/" }} routine={routine} />
      <GoalPage back={{ to: "/" }} goal={goal} routines={[]} />
    </>,
  );

  // The first read that says it's used up opens it, saying it plainly.
  await opened();
  const said = dialog()?.textContent ?? "";
  expect(said).toContain("You've used your free trial");
  expect(said).toContain("Your free trial was 500 Bot runs");
  expect(said).toContain("$5 a month for each member of this organization");
  expect(said).not.toContain(EMPLOYEE_LINE);
  expect(view.queryByAltText(SENTRY_ALT)).toBeNull();
  const pay = view.getByRole("link", { name: "Add a card" });
  expect(pay.getAttribute("href")).toBe(ADD_CARD);
  await dismiss();

  const tries: [string, () => HTMLElement][] = [
    ["send a message", () => view.getByLabelText("Send message")],
    [
      "Run now on a routine",
      () =>
        view.getByRole("button", {
          name: "Run the routine scheduled Weekdays at 09:00 now",
        }),
    ],
    [
      "Run now on a goal",
      () => {
        const row = [...view.container.querySelectorAll("button")].find(
          (button) => button.textContent?.startsWith("Run now"),
        );
        if (!row) throw new Error("no Run now on the goal");
        return row;
      },
    ],
  ];
  for (const [what, control] of tries) {
    await act(async () => {
      fireEvent.click(control());
    });
    await settled();
    expect(dialog(), what).not.toBeNull();
    await dismiss();
  }
  // And the next try opens it again.
  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });
  await settled();
  expect(dialog()).not.toBeNull();

  // Nothing reached the server, and the words are still in the box to send later.
  expect(writes).toEqual([]);
  expect(sent).toEqual([]);
  expect(view.container.textContent).toContain("Summarize this week's signups");
});

test("a member is told to ask an admin, with no button", async () => {
  plan = usedUp(false);
  const view = open(null);
  await opened();
  expect(dialog()?.textContent).toContain(
    "Ask an admin of this organization to add a card.",
  );
  expect(dialog()?.textContent).not.toContain(EMPLOYEE_LINE);
  expect(view.queryByAltText(SENTRY_ALT)).toBeNull();
  expect(view.queryAllByRole("link")).toHaveLength(0);
});

test("a run the server refuses for want of a plan opens the dialog, from a REST call or a Bot's run", async () => {
  // The plan read still says runs are left; the server knows better.
  plan = {
    required: true,
    status: "free",
    freeRunsUsedPercent: 99,
    trialEndsAt: null,
    renewsAt: null,
    addCardUrl: null,
  };
  await planRead();
  refuseRuns = true;
  const view = open(<RoutinePage back={{ to: "/" }} routine={routine} />);
  await settleReactWork();
  expect(dialog()).toBeNull();

  plan = usedUp(true);
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: "Run the routine scheduled Weekdays at 09:00 now",
      }),
    );
  });
  await opened();
  expect(writes).toEqual([
    `POST /api/v2/organizations/${ORG}/routines/routine-1/run`,
  ]);
  // Read again as it opened, so it names the trial the server now says was used.
  await waitFor(() =>
    expect(dialog()?.textContent).toContain("Your free trial was 500 Bot runs"),
  );
  await dismiss();

  // A Bot's run, refused the same way, as the runtime's client reports it.
  await act(async () => {
    stoppedReason(
      new Error(
        `REST run request failed: ${JSON.stringify({
          type: "https://open.bot/errors/plan-required",
          status: 402,
          detail: "You've used your free trial.",
          code: "PLAN_REQUIRED",
        })}`,
      ),
    );
  });
  await opened();
});

/*
 * Found on the end-to-end run: the dialog opened by itself again on every full page load (a
 * reload, a link opened afresh, Back from the payment page), because only the page remembered it
 * had. It opens by itself once for a person in an organization; after that only on an AI try.
 */
test("it opens by itself once, and not again when the page loads again", async () => {
  plan = usedUp(true);
  open(null);
  await opened();
  await dismiss();
  cleanup();

  // The page loaded again: its memory is gone, the browser's is not.
  forgetTrialUsedUpAnnounced("page");
  queryClient.clear();
  signedIn();
  const again = open(
    <Composer compact initialValue="Try again" onSubmit={() => undefined} />,
  );
  for (let tries = 0; tries < 5; tries++) await settled();
  expect(dialog()).toBeNull();

  // Still opens on an AI try.
  await act(async () => {
    fireEvent.click(again.getByLabelText("Send message"));
  });
  await opened();
});

/*
 * Found on the end-to-end run: opened by a refusal while the plan as last read still said runs were
 * left, an admin read the member's "Ask an admin" until the plan read again had answered. The
 * refusal carries the payment page only for an owner or an admin, so that decides it at once.
 */
test("opened by a refusal before the plan is read again, an admin is told to add a card", async () => {
  plan = {
    required: true,
    status: "free",
    freeRunsUsedPercent: 99,
    trialEndsAt: null,
    renewsAt: null,
    addCardUrl: null,
  };
  await planRead();
  refuseRuns = true;
  const view = open(<RoutinePage back={{ to: "/" }} routine={routine} />);
  await settled();

  // The server is slow to say the plan again.
  let answer = () => {};
  planHeld = new Promise((resolve) => {
    answer = resolve;
  });
  plan = usedUp(true);
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: "Run the routine scheduled Weekdays at 09:00 now",
      }),
    );
  });
  await opened();
  const said = dialog()?.textContent ?? "";
  expect(said).toContain("Add a card to keep your Bots running.");
  expect(said).not.toContain("Ask an admin");
  expect(
    view.getByRole("link", { name: "Add a card" }).getAttribute("href"),
  ).toBe(ADD_CARD);

  await act(async () => {
    answer();
  });
  await waitFor(() =>
    expect(dialog()?.textContent).toContain("Your free trial was 500 Bot runs"),
  );
  expect(dialog()?.textContent).not.toContain("Ask an admin");
});

/*
 * A CopilotKit employee never pays. Their trial is counted like everyone's, and once it is used up
 * the same dialog opens by itself once, in the same words, with a thank-you in place of the way to
 * pay. Their runs are never refused, so nothing stops an AI action and the dialog never opens on one,
 * and there is no blocked notice over the page.
 */
test("a CopilotKit employee past the cap is told once, with thanks and no way to pay, and their AI actions go through", async () => {
  plan = employeeUsedUp();
  const sent: string[] = [];
  const view = open(
    <>
      <PlanBanner />
      <Composer
        compact
        initialValue="Summarize this week's signups"
        onSubmit={(draft) => {
          sent.push(draft.text);
        }}
      />
      <RoutinePage back={{ to: "/" }} routine={routine} />
    </>,
  );

  await opened();
  const said = dialog()?.textContent ?? "";
  expect(said).toContain("You've used your free trial");
  expect(said).toContain(
    "Your free trial was 500 Bot runs, and they're all used.",
  );
  expect(said).toContain(
    "From now on, OpenBot is $5 a month for each member of this organization.",
  );
  expect(said).toContain(EMPLOYEE_LINE);
  expect(said).toContain("Sentry loves you too.");
  const photo = view.getByAltText(SENTRY_ALT);
  expect(photo.getAttribute("loading")).toBe("lazy");
  expect(said).not.toContain("Ask an admin");
  expect(said).not.toContain("Add a card");
  // Only a way to close.
  expect(dialog()?.querySelectorAll("a")).toHaveLength(0);
  expect(document.querySelector('aside[aria-label="Plan"]')).toBeNull();
  await dismiss();

  // Sending a message goes through, and Run now reaches the server; neither opens the dialog.
  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });
  await settled();
  expect(dialog()).toBeNull();
  await waitFor(() => expect(sent).toEqual(["Summarize this week's signups"]));
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: "Run the routine scheduled Weekdays at 09:00 now",
      }),
    );
  });
  await waitFor(() =>
    expect(writes).toEqual([
      `POST /api/v2/organizations/${ORG}/routines/routine-1/run`,
    ]),
  );
  await settled();
  expect(dialog()).toBeNull();
  cleanup();

  // The page loaded again: it doesn't open by itself a second time.
  forgetTrialUsedUpAnnounced("page");
  queryClient.clear();
  signedIn();
  open(null);
  for (let tries = 0; tries < 5; tries++) await settled();
  expect(dialog()).toBeNull();
});

/*
 * An organization behind on its payment keeps that status for a CopilotKit employee in it: their
 * own runs still go on, with no dialog and no banner, but the Plan row shows the failed payment and
 * gives an admin Update card, since the bill is the organization's and everyone else in it is
 * stopped.
 */
test("a CopilotKit employee in an organization whose payment failed can still send, and the Plan row shows the failed payment", async () => {
  plan = {
    required: true,
    status: "past_due",
    freeRunsUsedPercent: 100,
    freeRunsAllowance: 500,
    copilotKitEmployee: true,
    trialEndsAt: null,
    renewsAt: null,
    addCardUrl: ADD_CARD,
  };
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [
      {
        id: ORG,
        slug: "ana",
        name: "Ana's organization",
        role: "owner",
        active: true,
        personal: true,
      },
    ],
    canCreate: true,
    currentId: ORG,
  });
  const sent: string[] = [];
  const view = open(
    <>
      <PlanBanner />
      <OrganizationSettingsPage />
      <Composer
        compact
        initialValue="Summarize this week's signups"
        onSubmit={(draft) => {
          sent.push(draft.text);
        }}
      />
    </>,
  );

  await view.findByText("Last payment failed");
  expect(
    view.getByRole("link", { name: "Update card" }).getAttribute("href"),
  ).toBe(ADD_CARD);
  for (let tries = 0; tries < 5; tries++) await settled();
  expect(dialog()).toBeNull();
  expect(document.querySelector('aside[aria-label="Plan"]')).toBeNull();

  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });
  await settled();
  expect(dialog()).toBeNull();
  await waitFor(() => expect(sent).toEqual(["Summarize this week's signups"]));
});

/*
 * Found on the end-to-end run: an employee who is an admin couldn't pay for coworkers who aren't
 * employees. The server sends them the payment page while their own plan stays free; the Plan row
 * offers Add a card, and nothing stops their own AI actions.
 */
test("a CopilotKit employee admin can add a card for the others from the Plan row, and still sends", async () => {
  plan = { ...employeeUsedUp(), addCardUrl: ADD_CARD };
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [
      {
        id: ORG,
        slug: "acme",
        name: "Acme Research",
        role: "owner",
        active: true,
        personal: false,
      },
    ],
    canCreate: true,
    currentId: ORG,
  });
  // Told once already, so only the page is on screen.
  rememberTrialUsedUpAnnounced("ana", ORG);
  const sent: string[] = [];
  const view = open(
    <>
      <PlanBanner />
      <OrganizationSettingsPage />
      <Composer
        compact
        initialValue="Summarize this week's signups"
        onSubmit={(draft) => {
          sent.push(draft.text);
        }}
      />
    </>,
  );

  const pay = await view.findByRole("link", { name: "Add a card" });
  expect(pay.getAttribute("href")).toBe(ADD_CARD);
  expect(view.container.textContent).toContain(
    "Everyone else in this organization needs a card added to keep their Bots running.",
  );
  expect(view.container.textContent).toContain(EMPLOYEE_LINE);
  expect(document.querySelector('aside[aria-label="Plan"]')).toBeNull();

  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });
  await settled();
  expect(dialog()).toBeNull();
  await waitFor(() => expect(sent).toEqual(["Summarize this week's signups"]));
});

test("the Plan row tells a CopilotKit employee past the cap their runs are free", async () => {
  plan = employeeUsedUp();
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [
      {
        id: ORG,
        slug: "ana",
        name: "Ana's organization",
        role: "owner",
        active: true,
        personal: true,
      },
    ],
    canCreate: true,
    currentId: ORG,
  });
  // Told once already, so only the row is on screen.
  rememberTrialUsedUpAnnounced("ana", ORG);
  const view = open(<OrganizationSettingsPage />);

  const bar = await view.findByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
  expect(bar.textContent).toContain("100% used");
  await view.findByText(EMPLOYEE_LINE);
  expect(view.queryByRole("link", { name: "Add a card" })).toBeNull();
  expect(dialog()).toBeNull();
});
