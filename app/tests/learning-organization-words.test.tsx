import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { LearningPage } from "@/routes/_authed/admin/learning";
import {
  LEARNING,
  learningConfigurationBody,
  learningContract,
  ORGANIZATION,
  overviewBody,
  problem,
  requestOf,
  served,
} from "./learning-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Automatic learning, as an admin of one organization among several reads it.
 *
 * Outside the first organization, OpenBot keeps a Learning container for each organization alone,
 * and its id is a digest that says nothing to a person. Seen on the real page: the container read
 * "OpenBot: org-<32 hex> (org-<32 hex>)" and the picker said "Deployment default". The page names
 * the container by the organization, takes and shows only the part of an id the admin chose, and
 * never draws the digest. The first organization of an install reads as it always did.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

const HARBOR = { id: "org_harbor", slug: "harbor", name: "Harbor Finance" };
/** The space OpenBot keeps for Harbor Finance alone, as the server names it. */
const OWN = "org-d17bced7ea39b8c1abe1275faae2e74d";
/** A space's id of either kind the server derives: an organization's, or a person's. */
const DIGEST = /(?:org|user)-[0-9a-f]{32}/;

const bot = (id: string, name: string) => ({
  id,
  name,
  title: "Bot",
  roleDescription: "Helps",
  avatarSeed: id,
  visibility: "public",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  systemOwned: true,
  canManage: true,
  mine: false,
});

type Server = {
  /** The organization the person works in, or null where OpenBot keeps one and lists none. */
  organization: typeof HARBOR | null;
  settings: Record<string, unknown>;
  automatic: Record<string, unknown> | null;
  organizationSpaceId?: string | null;
  bots: ReturnType<typeof bot>[];
  /** Each save, as the page sent it. */
  saved: Record<string, unknown>[];
};

/** Answers the page as the API does, for the organization the person works in. */
function serve(server: Server) {
  const address = server.organization
    ? `/api/v2/organizations/${server.organization.id}`
    : ORGANIZATION;
  const configuration = () => ({
    ...learningConfigurationBody({
      settings: server.settings,
      automatic: server.automatic,
    }),
    ...(server.organizationSpaceId === undefined
      ? {}
      : { organizationSpaceId: server.organizationSpaceId }),
  });
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestOf(input, init);
      // What OpenBot offers, in the organization the person works in, as the server answers it.
      if (
        request.path === `${ORGANIZATION}/deployment` ||
        request.path === `${address}/deployment`
      )
        return Response.json({
          generativeUi: true,
          selfHostBanner: false,
          localEvaluation: false,
          edition: "team",
        });
      if (request.path === "/api/v2/people/me/organizations")
        return server.organization
          ? Response.json({
              organizations: [
                { ...server.organization, role: "admin", active: true },
              ],
              canCreate: false,
              nextCursor: null,
            })
          : new Response(null, { status: 404 });
      if (!request.path.startsWith(`${address}/`))
        return problem(
          404,
          "Couldn't find that organization.",
          "ORGANIZATION_NOT_FOUND",
        );
      // The rest is written as the first organization's addresses, which the builders name.
      const path = `${ORGANIZATION}${request.path.slice(address.length)}`;
      if (path === LEARNING.settings) {
        if (request.method === "PATCH") {
          server.saved.push(request.body ?? {});
          server.settings = { ...server.settings, ...request.body };
          return served(
            learningContract.UpdateLearningSettingsResponse,
            configuration(),
          );
        }
        return served(
          learningContract.GetLearningSettingsResponse,
          configuration(),
        );
      }
      if (path === LEARNING.overview) {
        const botId = request.query.get("botId");
        const own = botId
          ? (server.settings.bots as Record<string, { containerId: string }>)[
              botId
            ]
          : undefined;
        const id =
          own?.containerId ??
          (server.settings.defaultTarget as { containerId: string } | null)
            ?.containerId;
        return served(
          learningContract.GetLearningOverviewResponse,
          overviewBody(
            id
              ? {
                  // A space OpenBot made is named in the backend by its id alone.
                  container: {
                    id,
                    name: DIGEST.test(id) ? `OpenBot: ${id}` : "OpenBot",
                  },
                }
              : { configuration: "not_configured", container: undefined },
          ),
        );
      }
      if (path === `${ORGANIZATION}/bots`)
        return Response.json({
          bots: request.query.get("hidden") === "true" ? [] : server.bots,
          nextCursor: null,
        });
      return problem(
        502,
        "Couldn't reach Learning in the backend. Try again.",
        "LEARNING_UNREACHABLE",
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

function page() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: LearningPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Everything the page draws: its markup, with every attribute, and what each field holds. */
function drawn(): string {
  return [
    document.body.innerHTML,
    ...Array.from(document.querySelectorAll("input, textarea"), (field) =>
      String((field as HTMLInputElement).value),
    ),
  ].join("\n");
}

function harbor(overrides: Partial<Server> = {}): Server {
  return {
    organization: HARBOR,
    settings: {
      enabled: true,
      defaultTarget: { containerId: OWN },
      bots: { "ops-bot": { containerId: `${OWN}-ops` } },
    },
    automatic: { state: "assigned", containerId: OWN },
    organizationSpaceId: OWN,
    bots: [bot("ops-bot", "Ops Bot"), bot("desk-bot", "Desk Bot")],
    saved: [],
    ...overrides,
  };
}

test("inside an organization the page names its Learning by the organization, and never draws the container's id", async () => {
  setCurrentOrganization(HARBOR.id);
  const server = harbor();
  serve(server);
  const view = page();
  const user = userEvent.setup({ document });

  // The container shown is the organization's own, named for it.
  await view.findByText("Default container for Harbor Finance");
  const shown = view.getByRole("combobox", { name: "Show the container for" });
  expect(shown.textContent).toContain("This organization's default");
  // A Bot with no container of its own uses the organization's.
  expect(
    view.getByRole("combobox", { name: "Desk Bot participation" }).textContent,
  ).toContain("Use this organization's default");
  // The default's field is empty, which is the organization's default, and says so.
  const field = view.getByLabelText("Default container ID") as HTMLInputElement;
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("This organization's default");
  // A container the admin chose reads as the name they gave it.
  expect(
    (view.getByLabelText("Ops Bot container ID") as HTMLInputElement).value,
  ).toBe("ops");
  await view.findByText(
    "Bots in Harbor Finance learn into this organization's default container. You can change it here.",
  );

  expect(drawn()).not.toMatch(DIGEST);
  expect(drawn()).not.toMatch(/deployment default/i);

  // The same for a Bot's own container, and for every choice the picker offers.
  await user.click(shown);
  await view.findByRole("option", { name: "This organization's default" });
  expect(drawn()).not.toMatch(DIGEST);
  expect(drawn()).not.toMatch(/deployment default/i);
  await user.click(await view.findByRole("option", { name: "Ops Bot" }));
  await view.findByText('The "ops" container for Harbor Finance');
  expect(drawn()).not.toMatch(DIGEST);
});

test("an admin names another container of the organization's by its own name, and the page sends the id the server keeps", async () => {
  setCurrentOrganization(HARBOR.id);
  const server = harbor();
  serve(server);
  const view = page();
  const user = userEvent.setup({ document });
  const field = (await view.findByLabelText(
    "Default container ID",
  )) as HTMLInputElement;
  await user.type(field, "sales");
  expect(field.value).toBe("sales");
  fireEvent.click(view.getByRole("button", { name: "Save Learning settings" }));
  await waitFor(() => expect(server.saved).toHaveLength(1));
  expect(server.saved[0]?.defaultTarget).toEqual({
    containerId: `${OWN}-sales`,
  });
  await view.findByText("Settings saved.");
  expect(drawn()).not.toMatch(DIGEST);

  // Emptied, it is the organization's default again: never no container at all.
  await user.type(
    view.getByLabelText("Default container ID"),
    "{Backspace}".repeat("sales".length),
  );
  expect(
    (view.getByLabelText("Default container ID") as HTMLInputElement).value,
  ).toBe("");
  fireEvent.click(view.getByRole("button", { name: "Save Learning settings" }));
  await waitFor(() => expect(server.saved).toHaveLength(2));
  expect(server.saved[1]?.defaultTarget).toEqual({ containerId: OWN });
});

test("an organization whose container isn't there yet is told so in its own words, with the button to create it", async () => {
  setCurrentOrganization(HARBOR.id);
  serve(
    harbor({
      automatic: {
        state: "absent",
        containerId: OWN,
        canCreate: true,
        createError: "The backend refused to create the container.",
      },
    }),
  );
  const view = page();
  await view.findByText(
    "This organization's default container doesn't exist yet. Nothing is collected.",
  );
  await view.findByRole("button", {
    name: "Create this organization's default container",
  });
  expect(drawn()).not.toMatch(DIGEST);
  expect(drawn()).not.toMatch(/deployment default/i);
});

test("an install's first organization reads as it always did", async () => {
  for (const organizationSpaceId of [null, undefined]) {
    serve({
      organization: null,
      settings: { enabled: true, defaultTarget: { containerId: "openbot" } },
      automatic: { state: "assigned", containerId: "openbot" },
      organizationSpaceId,
      bots: [bot("desk-bot", "Desk Bot")],
      saved: [],
    });
    const view = page();
    await view.findByText("OpenBot (openbot)");
    expect(
      view.getByRole("combobox", { name: "Show the container for" })
        .textContent,
    ).toContain("Deployment default");
    expect(
      view.getByRole("combobox", { name: "Desk Bot participation" })
        .textContent,
    ).toContain("Use deployment default");
    const field = view.getByLabelText(
      "Default container ID",
    ) as HTMLInputElement;
    expect(field.value).toBe("openbot");
    await view.findByText(
      'OpenBot assigned this project\'s "openbot" container automatically',
      { exact: false },
    );
    cleanup();
  }
});

/*
 * REPORTED: every organization now learns in a backend project of its own, with the `openbot`
 * container assigned in it as `default`'s always was, so the server names no container kept for an
 * organization alone (`organizationSpaceId` null) in any of them. Every organization but the first
 * then read "Deployment default", as if its Bots learned into a container the deployment shares.
 * Where the person works in one of several organizations, the default is that organization's.
 */
test("in an organization of its own project, with no container named for it, the default is still the organization's", async () => {
  setCurrentOrganization(HARBOR.id);
  serve(
    harbor({
      settings: {
        enabled: true,
        defaultTarget: { containerId: "openbot" },
        bots: { "ops-bot": { containerId: "ops-learning" } },
      },
      automatic: { state: "assigned", containerId: "openbot" },
      organizationSpaceId: null,
    }),
  );
  const view = page();
  const user = userEvent.setup({ document });

  await view.findByText(
    'Bots in Harbor Finance learn into its "openbot" container, which OpenBot assigned automatically. You can change it here.',
  );
  const shown = view.getByRole("combobox", { name: "Show the container for" });
  expect(shown.textContent).toContain("This organization's default");
  expect(
    view.getByRole("combobox", { name: "Desk Bot participation" }).textContent,
  ).toContain("Use this organization's default");
  // The ids are names an admin reads in the backend, and stay as they are.
  expect(
    (view.getByLabelText("Default container ID") as HTMLInputElement).value,
  ).toBe("openbot");
  expect(
    (view.getByLabelText("Ops Bot container ID") as HTMLInputElement).value,
  ).toBe("ops-learning");
  expect(drawn()).not.toMatch(/deployment default/i);

  await user.click(shown);
  await view.findByRole("option", { name: "This organization's default" });
  expect(drawn()).not.toMatch(/deployment default/i);
});

test("in an organization of its own project whose container isn't there yet, the organization is told so", async () => {
  setCurrentOrganization(HARBOR.id);
  serve(
    harbor({
      settings: { enabled: true, defaultTarget: null, bots: {} },
      automatic: { state: "absent", containerId: "openbot", canCreate: true },
      organizationSpaceId: null,
    }),
  );
  const view = page();
  await view.findByText(
    'Harbor Finance has no "openbot" Learning container yet. Nothing is collected.',
  );
  expect(drawn()).not.toMatch(/deployment default/i);
});
