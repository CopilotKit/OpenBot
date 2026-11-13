import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import type * as React from "react";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

/*
 * Admin in the personal edition. Every page opens where it is. One whose settings need a team says
 * so, with the sentence the personal edition shows, and never asks the server for an API the
 * personal edition does not have. One that shows the person's own Bots loads what it shows.
 *
 * The server is faked at the fetch boundary, and every request a page makes is kept, so a page
 * that asked for a closed API fails here the way it would show an error in the product.
 */
mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));

const { Route: PeopleRoute } = await import("@/routes/_authed/admin/people");
const { Route: IdentityProvidersRoute } = await import(
  "@/routes/_authed/admin/identity-providers"
);
const { Route: PermissionsRoute } = await import(
  "@/routes/_authed/admin/permissions"
);
const { Route: PermissionsDescribeRoute } = await import(
  "@/routes/_authed/admin/permissions_.describe"
);
const { Route: ApprovalsRoute } = await import(
  "@/routes/_authed/admin/approvals"
);
const { Route: ApprovalsDescribeRoute } = await import(
  "@/routes/_authed/admin/approvals_.describe"
);
const { Route: GuidanceRoute } = await import(
  "@/routes/_authed/admin/approvals_.guidance"
);
const { Route: LearningRoute } = await import(
  "@/routes/_authed/admin/learning"
);
const { Route: ComputersRoute } = await import(
  "@/routes/_authed/admin/computers"
);
const { CheckInsPage } = await import("@/routes/_authed/admin/proactive");
const { ProvidersPage } = await import("@/routes/_authed/admin/providers");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const FOR_A_TEAM = "This applies when OpenBot runs for a team.";

/** Every path the page asked the server for. */
let asked: string[] = [];

/** What the personal edition's server answers. Everything else is a 404, as the edition gate's. */
function servePersonal() {
  asked = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    asked.push(path);
    if (path === "/api/models/available")
      return Response.json({
        provider: "openai",
        source: "openai",
        exposure: "all",
        default: "gpt-5.6-terra",
        listed: true,
        models: [
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", vendor: "openai" },
          { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
        ],
      });
    if (path === "/api/admin/enterprise/models/usage")
      return Response.json({
        days: 30,
        summary: [
          {
            model: "openai/gpt-5.6-terra",
            source: "openai",
            runs: 3,
            people: 1,
            refused: 0,
            lastUsedAt: "2026-11-12T09:00:00.000Z",
          },
        ],
        recent: [],
      });
    if (path === "/api/admin/proactive")
      return Response.json({
        days: 7,
        dailyRuns: 24,
        bots: [],
        pings: { sent: 0, itemsPerPing: null },
      });
    const bots = answerBotsList(path, init, { visible: [] });
    if (bots) return bots;
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

function edition(edition: "team" | "personal") {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
}

beforeEach(() => {
  queryClient.clear();
  edition("personal");
  servePersonal();
});

async function draw(page: () => React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => React.ReactNode;

test.each([
  ["People", PeopleRoute, "Here, you're the only person, and the admin."],
  ["Identity providers", IdentityProvidersRoute, "Here, nobody signs in."],
  ["Permissions", PermissionsRoute, undefined],
  ["Describe who can do what", PermissionsDescribeRoute, undefined],
  ["Approvals", ApprovalsRoute, "Set your own in Settings → Approvals."],
  ["Describe team rules", ApprovalsDescribeRoute, "Set your own in"],
  ["Guidance for auto-review", GuidanceRoute, "Set your own in"],
  [
    "Automatic learning",
    LearningRoute,
    "Review what OpenBot learns on Skills.",
  ],
])(
  "%s keeps its page and says it applies to a team",
  async (title, route, more) => {
    const view = await draw(component(route));
    expect(
      await view.findByRole("heading", { level: 1, name: title }),
    ).toBeTruthy();
    const box = await view.findByText((_, node) =>
      Boolean(
        node?.textContent?.startsWith(FOR_A_TEAM) &&
          node.getAttribute("data-slot") === "empty-description",
      ),
    );
    if (more) expect(box.textContent).toContain(more);
    expect(view.getByText("For a team")).toBeTruthy();
    expect(
      view.getByRole("button", { name: /Meet OpenBot for Business/ }),
    ).toBeTruthy();
    // Nothing it would have shown was asked for.
    await settleReactWork();
    expect(asked.filter((path) => path.startsWith("/api/admin"))).toEqual([]);
  },
);

test("Approvals and Automatic learning link to where the person sets their own", async () => {
  const approvals = await draw(component(ApprovalsRoute));
  expect(
    (
      await approvals.findByRole("link", { name: "Settings → Approvals" })
    ).getAttribute("href"),
  ).toBe("/settings/approvals");
  cleanup();
  const learning = await draw(component(LearningRoute));
  expect(
    (await learning.findByRole("link", { name: "Skills" })).getAttribute(
      "href",
    ),
  ).toBe("/skills");
});

test("Providers shows who serves the models and what the Bots ran on, without the team's settings", async () => {
  const view = await draw(ProvidersPage);
  expect(await view.findByText("OpenAI")).toBeTruthy();
  expect(
    await view.findByText("Default gpt-5.6-terra · 2 models listed"),
  ).toBeTruthy();
  expect(await view.findByText("Every listed model")).toBeTruthy();
  expect(await view.findByText("openai/gpt-5.6-terra")).toBeTruthy();
  expect(view.getByText(/3 runs by 1 person/)).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText(FOR_A_TEAM)).toBeNull();
  expect(asked).not.toContain("/api/admin/enterprise");
});

test("Routines shows how check-ins went, and the check-in switch is for a team", async () => {
  const view = await draw(CheckInsPage);
  expect(
    await view.findByRole("heading", { level: 2, name: "How check-ins went" }),
  ).toBeTruthy();
  const checkIns = (
    await view.findByRole("heading", { level: 2, name: "Check-ins" })
  ).closest("section") as HTMLElement;
  expect(within(checkIns).getByText(FOR_A_TEAM)).toBeTruthy();
  expect(within(checkIns).queryByRole("switch")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  expect(asked).not.toContain("/api/admin/enterprise");
});

test("Computers keeps the idle and network settings in place, for a team", async () => {
  const view = await draw(component(ComputersRoute));
  for (const title of ["Idle computers", "Network"]) {
    const section = (
      await view.findByRole("heading", { level: 2, name: title })
    ).closest("section") as HTMLElement;
    expect(within(section).getByText(FOR_A_TEAM)).toBeTruthy();
  }
  expect(asked).not.toContain("/api/admin/enterprise");
});

test("in the team edition the same pages are the team's, and ask for what they show", async () => {
  edition("team");
  const view = await draw(component(PeopleRoute));
  await view.findByRole("heading", { level: 1, name: "People" });
  await settleReactWork();
  expect(view.queryByText(FOR_A_TEAM)).toBeNull();
  expect(asked.some((path) => path.startsWith("/api/admin/people"))).toBe(true);
});
