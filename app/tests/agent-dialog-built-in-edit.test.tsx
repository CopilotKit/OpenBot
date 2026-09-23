import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDialog } from "@/components/agents/agent-dialog";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";

/**
 * Editing a coworker that runs on this deployment's own Bot.
 *
 * A coworker created as "Built in" on a deployment with a managed Bot is stored pointing at that
 * Bot's address, and the profile publishes it, with `builtIn` beside it so a screen can tell. The
 * Connection section already reads that flag and does not show "an internal address they never
 * typed". The General section did not: every in-place edit sent the whole profile back, endpoint
 * included, and `PATCH /api/agents/:id` checks an endpoint it is sent the way it checks one a person
 * typed. `scripts/start.sh` points the managed Bot at `http://localhost:4201/ag-ui`, which that check
 * refuses unless private hosts are opened, so on that deployment a built-in coworker could not be
 * renamed, retitled, redescribed or made public at all.
 *
 * The routes are the server's own, mounted behind `fetch` the way `agent-api-path.test.ts` mounts
 * them, so the refusal is the real one. The dialog is drawn in a router of one route, for the
 * `useNavigate` its General section holds.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** What `scripts/start.sh` sets `MANAGED_AGENT_AG_UI_URL` to. */
const MANAGED = "http://localhost:4201/ag-ui";

const actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];

beforeEach(() => {
  updates = [];
});

function serve(endpoint: string) {
  let profile: AgentProfile = {
    id: "expenses",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint,
    hasAuth: false,
    hasCallbackToken: false,
  };
  const store = {
    get: async () => profile,
    update: async (_actor: unknown, _id: string, value: object) => {
      updates.push({ ...value });
      const { endpoint: moved, ...rest } = value as { endpoint?: string };
      profile = { ...profile, ...rest, endpoint: moved ?? profile.endpoint };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  // Private hosts closed, as on a deployment that did not open them, and the managed Bot named.
  const routes = createAgentRoutes(
    store,
    auth,
    false,
    undefined,
    new Set(),
    undefined,
    true,
    MANAGED,
  );
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof path !== "string" || !path.startsWith("/api/agents/")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <AgentDialog agentId="expenses" onClose={() => {}} open />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function rename(view: ReturnType<typeof draw>, to: string) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Edit name" }));
  const field = view.getByDisplayValue("Expenses");
  await user.clear(field);
  await user.type(field, to);
  await user.click(view.getByRole("button", { name: "Save" }));
}

test("a built-in coworker can be renamed on a deployment whose own Bot lives on localhost", async () => {
  serve(MANAGED);
  const view = draw();

  await rename(view, "Receipts");

  // Settled one way or the other: saved, or refused with a sentence under the field.
  await waitFor(() =>
    expect(updates.length + view.queryAllByRole("alert").length).toBe(1),
  );
  expect(view.queryByRole("alert")?.textContent ?? null).toBeNull();
  expect(updates[0]).toMatchObject({ name: "Receipts" });
  // The managed address is left where the store keeps it, not sent back as if somebody typed it.
  expect(updates[0]?.endpoint).toBeUndefined();
});

test("a coworker somebody hosts keeps its own endpoint when it is renamed", async () => {
  serve("https://agents.example.test/ag-ui");
  const view = draw();

  await rename(view, "Receipts");

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({
    name: "Receipts",
    endpoint: "https://agents.example.test/ag-ui",
  });
});
