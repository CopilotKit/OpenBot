import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  DEPLOY_LINE,
  openTeamFeatures,
  TEAM_FEATURE_GROUPS,
  TEAM_FEATURES,
  TeamFeaturesDialog,
} from "@/components/edition/team-features-dialog";
import { BOOKING_CALENDAR_TIMEOUT_MS } from "@/components/onboarding/booking-calendar";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AdminRoute } from "@/routes/_authed/admin/route";
import { settleReactWork } from "./settle-react-work";

// The booking calendar's frame keeps its address but never fetches it: no test reaches Calendly.
beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildFrameNavigation: true } },
  }),
);
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The booking calendar's frame inside the dialog. */
function calendarFrame(dialog: HTMLElement) {
  return dialog.querySelector<HTMLIFrameElement>(
    '[data-booking-calendar] iframe[title="Booking calendar"]',
  );
}

describe("the team features dialog", () => {
  /*
   * The OpenBot for Business page in the app: where it runs first and big, what it adds, and the
   * calendar to book a demo right there. It never sends anybody to the website while the calendar
   * is there to book in.
   */
  test("says where it runs first, lists every feature, and embeds the booking calendar", async () => {
    const view = render(<TeamFeaturesDialog />);
    expect(view.queryByRole("dialog")).toBeNull();
    act(() => openTeamFeatures());
    const dialog = await view.findByRole("dialog", {
      name: "OpenBot for Business",
    });
    expect(DEPLOY_LINE).toBe(
      "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud.",
    );
    // The dialog's description, so it is the first thing read after its name.
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(DEPLOY_LINE);
    for (const feature of TEAM_FEATURES) {
      expect(dialog.textContent).toContain(feature.title);
    }
    expect(view.getByRole("heading", { name: "Book a demo" })).toBeTruthy();
    const frame = calendarFrame(dialog);
    expect(frame?.getAttribute("src")).toStartWith(
      "https://calendly.com/d/dwfr-k64-8d2/openbot-for-business?",
    );
    expect(view.queryAllByRole("link")).toEqual([]);
    expect(view.queryByText("Talk to us")).toBeNull();
    expect(
      view.queryAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Close"]);
  });

  test("a calendar that can't load gives way to Book a demo, which opens the business page in a new tab", async () => {
    const view = render(<TeamFeaturesDialog />);
    act(() => openTeamFeatures());
    const dialog = await view.findByRole("dialog", {
      name: "OpenBot for Business",
    });
    const frame = calendarFrame(dialog);
    if (!frame) throw new Error("no booking calendar");

    fireEvent.error(frame);

    expect(
      await view.findByText(
        "Couldn't load the calendar. Book a demo opens it in your browser.",
      ),
    ).toBeTruthy();
    expect(calendarFrame(dialog)).toBeNull();
    const link = view.getByRole("link", { name: "Book a demo" });
    expect(link.getAttribute("href")).toBe("https://open.bot/business");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  /*
   * Every line is a claim about what OpenBot for Business does, so the list is pinned word for
   * word: a line changes here, on purpose, or not at all. "Policies in plain English, tested on past
   * activity" stands for the describe-in-words screens (boundaries, team approval rules, auto-review
   * guidance, permissions, the network allowlist, one Bot's app actions), each of which replays what
   * it wrote over recorded activity before it is saved.
   */
  test("says exactly these things, in these groups", () => {
    expect(
      TEAM_FEATURE_GROUPS.map((group) => [
        group.title,
        group.features.map((feature) => feature.title),
      ]),
    ).toEqual([
      [
        "For your whole team",
        [
          "Sign-in with Google, Microsoft or custom SSO",
          "People, roles and admins",
          "Bots shared with your whole team",
          "Learning shared across the team",
        ],
      ],
      [
        "Where your Bots work",
        ["Bots in Slack and Microsoft Teams", "A computer for each Bot"],
      ],
      [
        "In control",
        [
          "Controls over models, apps and networks",
          "Rules every Bot follows",
          "Policies in plain English, tested on past activity",
          "Governance for everyone",
          "A full audit trail, with export",
        ],
      ],
    ]);
  });

  /*
   * On a phone the calendar sits below the list, out of view, and a browser holds back a frame out
   * of view, so Calendly says nothing until somebody scrolls to it. The wait for it used to start on
   * opening, so somebody still reading the list was told the calendar couldn't load.
   */
  test("the calendar's wait for Calendly starts once it is on screen, not on opening", async () => {
    const observers: {
      callback: IntersectionObserverCallback;
      target?: Element;
    }[] = [];
    const realObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      private readonly entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    const waits: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
      if (delay === BOOKING_CALENDAR_TIMEOUT_MS) {
        waits.push(handler);
        return 0;
      }
      return realSetTimeout(handler, delay);
    }) as typeof setTimeout;
    try {
      const view = render(<TeamFeaturesDialog />);
      act(() => openTeamFeatures());
      const dialog = await view.findByRole("dialog", {
        name: "OpenBot for Business",
      });
      const frame = calendarFrame(dialog);
      const watching = observers.find((entry) => entry.target === frame);
      if (!watching) throw new Error("the calendar is not watched for view");
      expect(waits).toEqual([]);

      act(() =>
        watching.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
      expect(waits.length).toBe(1);

      // Still nothing from Calendly once it has been on screen that long: the fallback.
      act(() => waits[0]?.());
      expect(
        await view.findByRole("link", { name: "Book a demo" }),
      ).toBeTruthy();
    } finally {
      globalThis.IntersectionObserver = realObserver;
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("opens at its title, with focus on the column that holds it", async () => {
    const view = render(<TeamFeaturesDialog />);
    act(() => openTeamFeatures());
    const dialog = await view.findByRole("dialog");
    const title = view.getByRole("heading", { name: "OpenBot for Business" });
    // Base UI moves focus on the next frame; wait for it to land somewhere inside the dialog.
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    expect(document.activeElement?.contains(title)).toBe(true);
    expect(view.getByRole("button", { name: "Close" })).not.toBe(
      document.activeElement,
    );
  });
});

describe("Admin's guard, in both editions", () => {
  type BeforeLoad = (input: {
    context: { queryClient: QueryClient };
    location: { pathname: string };
  }) => Promise<unknown>;
  const beforeLoad = AdminRoute.options.beforeLoad as unknown as BeforeLoad;

  function clientFor(edition: "team" | "personal", role: "admin" | "user") {
    const client = new QueryClient();
    client.setQueryData(authKeys.currentUser(), {
      id: "u1",
      email: "me@example.test",
      name: "Me",
      role,
    });
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: edition === "personal",
      edition,
    });
    return client;
  }

  async function outcome(
    edition: "team" | "personal",
    role: "admin" | "user",
    pathname: string,
  ) {
    try {
      await beforeLoad({
        context: { queryClient: clientFor(edition, role) },
        location: { pathname },
      });
      return "open";
    } catch (thrown) {
      if (!isRedirect(thrown)) throw thrown;
      return thrown.options.href ?? thrown.options.to;
    }
  }

  const ADMIN_PAGES = [
    "/admin",
    "/admin/plugins",
    "/admin/plugins/notion/tools/search",
    "/admin/skills",
    "/admin/credentials/new",
    "/admin/computers",
    "/admin/audit",
    "/admin/people",
    "/admin/permissions",
    "/admin/identity-providers",
  ];

  test.each(ADMIN_PAGES)(
    "the personal edition's one person opens %s where it is",
    async (pathname) => {
      expect(await outcome("personal", "admin", pathname)).toBe("open");
    },
  );

  test("the team edition's admin opens Admin", async () => {
    expect(await outcome("team", "admin", "/admin/people")).toBe("open");
  });

  test("anybody who isn't an admin is sent home, in either edition", async () => {
    expect(await outcome("team", "user", "/admin/people")).toBe("/");
    expect(await outcome("team", "user", "/admin")).toBe("/");
    expect(await outcome("personal", "user", "/admin")).toBe("/");
  });
});
