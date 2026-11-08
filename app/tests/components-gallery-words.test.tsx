import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as CARDS } from "@/components/gallery/cards";
import { GALLERY as CHARTS } from "@/components/gallery/charts";
import { GALLERY as DECISIONS } from "@/components/gallery/decisions";
import { GALLERY as FORM } from "@/components/gallery/form";
import { GALLERY as QUOTE } from "@/components/gallery/quote";
import { GALLERY as TABLE } from "@/components/gallery/table";
import { type ComponentRecord, componentKeys } from "@/lib/components/queries";
import * as gallery from "@/lib/copilot/gallery-registry";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as DetailRoute } from "@/routes/_authed/settings/components-gallery/$name";
import { Route as IndexRoute } from "@/routes/_authed/settings/components-gallery/index";
import { settleReactWork } from "./settle-react-work";

/*
 * Settings > Components gallery is a page anybody can open, so it speaks to a person. Seen on
 * Windows, personal edition: the Activity report card read "Show what this deployment has actually
 * been doing, read from its own records rather than from anything you know", which is what the model
 * is told, and the intro said an admin controls which components each Bot can use, where there is no
 * admin. Every card now shows its summary; the team edition keeps its admin.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/*
 * Every component this build ships. `import.meta.glob` is Vite's, so under `bun test` the registry
 * finds no gallery modules; the lookup the pages use is answered from the same modules Vite loads.
 */
const ALL = [
  ...ACTIVITY,
  ...CARDS,
  ...CHARTS,
  ...DECISIONS,
  ...FORM,
  ...QUOTE,
  ...TABLE,
];
const compiled = spyOn(gallery, "galleryComponent");
beforeEach(() => {
  compiled.mockImplementation((name) => ALL.find((spec) => spec.name === name));
});
afterAll(() => compiled.mockRestore());

const originalFetch = global.fetch;
beforeAll(() => {
  // Nothing here is fetched that the cache does not already hold; anything else is not served.
  global.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

/** Each component as the server lists it after the build announced it: published in the model's words. */
const RECORDS: ComponentRecord[] = ALL.map((spec) => ({
  name: spec.name,
  title: spec.title,
  kind: spec.kind,
  draftDescription: spec.description,
  publishedDescription: spec.description,
  published: true,
  publishedAt: "2026-11-07T00:00:00Z",
  updatedBy: "the build",
  updatedAt: "2026-11-07T00:00:00Z",
  hasUnpublishedChanges: false,
  withheldFrom: [],
  functions: [],
}));

function draw(
  edition: "team" | "personal",
  at: string,
  records: ComponentRecord[] = RECORDS,
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(componentKeys.list(), records);

  // The two real routes, under the path they have in the app.
  const rootRoute = createRootRoute({ component: Outlet });
  const galleryRoute = createRoute({
    path: "/settings/components-gallery",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const index = createRoute({
    path: "/",
    getParentRoute: () => galleryRoute,
    component: IndexRoute.options.component,
  });
  const detail = createRoute({
    path: "/$name",
    getParentRoute: () => galleryRoute,
    component: DetailRoute.options.component,
  });
  // The page reads its name through its own route, which here is mounted as `detail`.
  const useParams = spyOn(DetailRoute, "useParams").mockImplementation((() =>
    detail.useParams()) as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      galleryRoute.addChildren([index, detail]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, restore: () => useParams.mockRestore() };
}

const PERSONAL_INTRO =
  "Browse the components your Bots can show in conversations. Every Bot can use all of them.";
const TEAM_INTRO =
  "Browse components that Bots can display in conversations. An admin controls which components each Bot can use.";

test("the personal gallery says what each component shows, not what the model is told", async () => {
  const { view, restore } = draw("personal", "/settings/components-gallery");
  try {
    expect(await view.findByText(PERSONAL_INTRO)).toBeTruthy();
    for (const spec of ALL) {
      const card = view.getByTestId(`gallery-${spec.name}`);
      expect(card.textContent).toContain(spec.summary);
      expect(card.textContent).not.toContain(spec.description);
    }
    const text = view.container.textContent ?? "";
    expect(text).toContain(
      "Shows what your Bots have been doing and what was refused, read from OpenBot's own records.",
    );
    expect(text).not.toContain("deployment");
    expect(text).not.toMatch(/\badmin/i);
  } finally {
    restore();
  }
});

test("the team gallery keeps its admin and shows the same summaries", async () => {
  const { view, restore } = draw("team", "/settings/components-gallery");
  try {
    expect(await view.findByText(TEAM_INTRO)).toBeTruthy();
    for (const spec of ALL) {
      const card = view.getByTestId(`gallery-${spec.name}`);
      expect(card.textContent).toContain(spec.summary);
      expect(card.textContent).not.toContain(spec.description);
    }
    expect(view.container.textContent).not.toContain("deployment");
  } finally {
    restore();
  }
});

test("an empty personal gallery does not wait on an admin", async () => {
  const { view, restore } = draw(
    "personal",
    "/settings/components-gallery",
    [],
  );
  try {
    expect(await view.findByText("No components yet")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/\badmin/i);
  } finally {
    restore();
  }
});

test("one component's page says what it shows, in either edition", async () => {
  for (const edition of ["personal", "team"] as const) {
    const { view, restore } = draw(
      edition,
      "/settings/components-gallery/showActivityReport",
    );
    try {
      expect(
        await view.findByText(
          "Shows what your Bots have been doing and what was refused, read from OpenBot's own records.",
        ),
      ).toBeTruthy();
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("deployment");
      expect(text).not.toContain("you will not see them");
    } finally {
      restore();
      cleanup();
    }
  }
});

test("every summary is a person's sentence", () => {
  for (const spec of ALL) {
    const { summary } = spec;
    expect(summary.length).toBeGreaterThan(0);
    // No tool names, internals or the marks of text explaining itself (see openbot-copy).
    expect(summary).not.toMatch(/\b(show|ask)[A-Z]\w+/);
    expect(summary).not.toMatch(/deployment|rather than|—/);
    expect(summary.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(summary).not.toBe(spec.description);
  }
});
