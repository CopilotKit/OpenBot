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
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { queryClient } from "@/query-client";
import { Route as SetupRoute } from "@/routes/_authed/settings/setup";
import type { Edition } from "../../server/src/edition";
import type { RuntimeEntitlementResponse } from "../../server/src/self-host-banner";
import {
  createSetupRoutes,
  createSetupSources,
} from "../../server/src/setup/checklist";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → Setup in each edition, with the server's own setup routes behind `fetch`, so every
 * sentence on the page is the one the server writes.
 *
 * The personal edition has no memory (#1233) and no admin. On Windows its Setup still said the back
 * end "Keeps your conversations and what OpenBot remembers", that people "can connect more apps
 * than the ones an admin adds", and linked the Admin pages by their Admin names, Credentials and
 * Computers, where its Settings call them Keys and Computer. A team deployment keeps its words.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
const defaults = queryClient.getDefaultOptions();
beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
  globalThis.fetch = originalFetch;
});

const ENTITLED: RuntimeEntitlementResponse = {
  status: "ready",
  entitlement: {
    active: true,
    source: "selfHostedDeploymentLicense",
    features: {},
    limits: {},
  },
};
/** Intelligence answered, and said the licence is not active. */
const INACTIVE: RuntimeEntitlementResponse = {
  status: "ready",
  entitlement: {
    active: false,
    source: "selfHostedDeploymentLicense",
    features: {},
    limits: {},
  },
};

/**
 * Serves `/api/setup` from the server's routes for one edition. No model key, so the model row
 * names the page to add one; a computer that is set up and not yet asked, so its row names the
 * page computers show up on. The person is an admin, as the one person on the personal edition is.
 */
function serve(
  edition: Edition,
  facts: { entitlement: RuntimeEntitlementResponse; moreApps: boolean },
) {
  const sources = createSetupSources({
    productName: "OpenBot",
    config: { singleUser: edition === "personal", edition },
    environment: {},
    model: {
      provider: "openai",
      keyId: "default",
      defaultModel: "gpt-5.6-terra",
      plan: false,
    },
    credentials: { list: async () => [] },
    entitlements: async () => facts.entitlement,
    computer: true,
    apps: { configured: facts.moreApps, provider: "composio" },
    chat: false,
  });
  const routes = createSetupRoutes(sources, async (context, next) => {
    context.set("actor", {
      id: "person",
      email: "person@example.test",
      role: "admin",
    });
    await next();
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (!path.startsWith("/api/setup")) throw new Error(`unexpected ${path}`);
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/setup".length) || "/"}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** The Setup page, as Settings draws it. */
async function draw() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: SetupRoute.options.component }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("list", { name: "Setup" });
  const row = (id: string) => {
    const found = view.container.querySelector<HTMLElement>(
      `[data-setup-row="${id}"]`,
    );
    if (!found) throw new Error(`no ${id} row`);
    return within(found);
  };
  return { view, row };
}

const linkTo = (row: ReturnType<typeof within>, name: string) =>
  row.getByRole("link", { name }).getAttribute("href");

test("the personal edition's Setup speaks of no memory and no admin", async () => {
  serve("personal", { entitlement: ENTITLED, moreApps: true });
  const { view, row } = await draw();

  expect(
    row("intelligence").getByText("Keeps your conversations and skills."),
  ).toBeTruthy();
  expect(
    row("apps").getByText(
      "You can connect more apps than the ones OpenBot comes with.",
    ),
  ).toBeTruthy();
  // The pages it links are the ones its Settings sidebar names.
  expect(linkTo(row("model"), "Keys")).toBe("/settings/credentials");
  expect(linkTo(row("computer"), "Computer")).toBe("/settings/computer");
  expect(view.container.textContent).not.toMatch(/remember|memory|admin/i);
  expect(view.container.innerHTML).not.toContain("/admin/");
});

test("the personal edition's gaps speak of no memory and no admin either", async () => {
  serve("personal", { entitlement: INACTIVE, moreApps: false });
  const { view, row } = await draw();

  expect(
    row("intelligence").getByText(
      "The backend says this deployment's licence isn't active.",
    ),
  ).toBeTruthy();
  expect(
    row("apps").getByText(
      "Without it, you can connect only the apps OpenBot comes with.",
    ),
  ).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/remember|memory|admin/i);
});

test("a team deployment's Setup keeps memory, its admin, and the Admin pages", async () => {
  serve("team", { entitlement: ENTITLED, moreApps: true });
  const { row } = await draw();

  expect(
    row("intelligence").getByText(
      "Keeps your conversations and what OpenBot remembers.",
    ),
  ).toBeTruthy();
  expect(
    row("apps").getByText(
      "People can connect more apps than the ones an admin adds.",
    ),
  ).toBeTruthy();
  expect(linkTo(row("model"), "Credentials")).toBe("/admin/credentials");
  expect(linkTo(row("computer"), "Computers")).toBe("/admin/computers");
});

test("a team deployment's gaps still say what an inactive licence keeps off", async () => {
  serve("team", { entitlement: INACTIVE, moreApps: false });
  const { row } = await draw();

  expect(
    row("intelligence").getByText(
      "The backend says this deployment's licence isn't active. Memory stays off until it is.",
    ),
  ).toBeTruthy();
  expect(
    row("apps").getByText(
      "Without it, people can connect only the apps an admin adds.",
    ),
  ).toBeTruthy();
});
