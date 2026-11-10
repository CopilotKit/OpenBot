import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KEY_FROM_OPENBOT } from "@/components/agents/callback-token-panel";
import { SetupSections } from "@/components/bot-profile/setup";
import {
  ISOLATED_EXPLAINED,
  ISOLATED_MAKING_PUBLIC,
  ISOLATED_PUBLIC_SHARES_LOGINS,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
  ISOLATION_WITHDRAWN,
} from "@/lib/agents/isolation";
import { agentQueryOptions } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import { settleReactWork } from "./settle-react-work";

/**
 * Editing a Bot that runs on this deployment's own Bot, from its Setup page.
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
 * them, so the refusal is the real one. The Setup sections are drawn in a router of one route, as
 * the Bot's Setup page draws them.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** What `scripts/start.sh` sets `MANAGED_AGENT_AG_UI_URL` to. */
const MANAGED = "http://localhost:4201/ag-ui";
/** The harness OpenBot Desktop runs for the personal starter, as `PICKED_HARNESS_URL` names it. */
const PICKED = "http://agent-harness:4212";

const actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];
/** Whether this person holds "Isolated Bots", as `/api/admin/enterprise/me` answers. */
let mayIsolate = true;

beforeEach(() => {
  updates = [];
  mayIsolate = true;
});

/** The switches as they apply to the person, in the shape the enterprise route answers. */
function me() {
  return Response.json({
    capabilities: { isolatedComputers: mayIsolate },
    enforced: true,
  });
}

function serve(
  endpoint: string,
  ownerUserId = actor.id,
  options: {
    isolated?: boolean;
    isolationAvailable?: boolean;
    visibility?: AgentProfile["visibility"];
    instructions?: string;
    title?: string;
  } = {},
) {
  let profile: AgentProfile = {
    id: "expenses",
    name: "Expenses",
    title: options.title ?? "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    ownerUserId,
    visibility:
      options.visibility ?? (ownerUserId === actor.id ? "private" : "public"),
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: options.isolated ?? false,
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
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
    undefined,
    // The addresses this deployment runs, as app.ts names them from its configuration.
    { token: "deployment-token", endpoints: [MANAGED, PICKED] },
    { available: options.isolationAvailable ?? true },
  );
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path === "/api/admin/enterprise/me") return me();
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

/** Loads the profile through the real route, as the Setup page does, then draws its sections. */
function Setup() {
  const agent = useQuery(agentQueryOptions("expenses"));
  return agent.data ? <SetupSections agent={agent.data} /> : null;
}

function draw(edition?: "team" | "personal") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition)
    queryClient.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: Setup }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function rename(view: ReturnType<typeof draw>, to: string) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: /^Name/ }));
  const field = await view.findByDisplayValue("Expenses");
  await user.clear(field);
  await user.type(field, to);
  await user.click(view.getByRole("button", { name: "Save" }));
}

test("the personal edition's Setup has no Visibility or Isolated: one person, one computer", async () => {
  serve(MANAGED);
  const view = draw("personal");
  expect(await view.findByRole("button", { name: /^Name/ })).toBeTruthy();
  expect(
    view
      .getByRole("link", {
        name: "Give each Bot its own computer with OpenBot for Business.",
      })
      .getAttribute("href"),
  ).toBe("https://open.bot/business");
  expect(view.queryByText("Visibility")).toBeNull();
  expect(view.queryByText("Isolated")).toBeNull();
});

/*
 * The starter Bot's header shows what it does, so what it does is a sentence for the person and
 * its instructions are their own row, labelled as instructions and saved on their own.
 */
test("the starter Bot's Setup edits its instructions apart from what it does", async () => {
  const instructions =
    "You are a personal assistant for one person. Be clear and brief.";
  serve(PICKED, actor.id, { instructions });
  const view = draw("personal");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  const described = await view.findByRole("button", { name: /^What it does/ });
  expect(described.textContent).toContain("Review receipts.");
  expect(described.textContent).not.toContain("You are");
  const instructed = view.getByRole("button", { name: /^Instructions/ });
  expect(instructed.textContent).toContain(instructions);

  await user.click(instructed);
  const field = await view.findByDisplayValue(instructions);
  await user.type(field, " I live in Berlin.");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({
    roleDescription: "Review receipts.",
    instructions: `${instructions} I live in Berlin.`,
  });
});

test("a Bot whose instructions are what it does has no separate Instructions row", async () => {
  serve(MANAGED);
  const view = draw("personal");
  expect(
    await view.findByRole("button", { name: /^What it does/ }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Instructions/ })).toBeNull();

  await rename(view, "Receipts");
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).not.toHaveProperty("instructions");
});

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

test("a Bot on the harness OpenBot runs says it can use its tools, and offers no key to make", async () => {
  serve(PICKED);
  const view = draw("personal");

  expect(await view.findByText(KEY_FROM_OPENBOT)).toBeTruthy();
  expect(view.queryByText(/can't use tools/)).toBeNull();
  expect(view.queryByRole("button", { name: "Generate key" })).toBeNull();
});

test("a Bot somebody hosts is still offered a key for its tools", async () => {
  serve("https://agents.example.test/ag-ui");
  const view = draw("personal");

  expect(
    await view.findByText(
      "This Bot has no key yet. It can talk but can't use tools. Generate a key and add it to your agent's configuration.",
    ),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Generate key" })).toBeTruthy();
});

test("someone who cannot manage the Bot reads its setup but cannot open an editor", async () => {
  serve(MANAGED, "someone-else");
  const view = draw();

  expect(await view.findByText("Expenses")).toBeTruthy();
  expect(view.queryByRole("button", { name: /^Name/ })).toBeNull();
});

/** The Isolated row's switch, found by the row's own title. */
async function isolatedSwitch(view: ReturnType<typeof draw>) {
  return view.findByRole("switch", { name: "Isolated" });
}

test("the Isolated row gives a Bot a computer of its own through the real route", async () => {
  serve(MANAGED);
  const view = draw();
  const toggle = await isolatedSwitch(view);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    view.getByText("Runs on your computer, alongside your other Bots."),
  ).toBeTruthy();

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(toggle);

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ isolated: true });

  // Read back through the route, as the page does on its next load: on, and in effect.
  cleanup();
  const reloaded = draw();
  expect(await reloaded.findByText(ISOLATED_EXPLAINED)).toBeTruthy();
  expect((await isolatedSwitch(reloaded)).getAttribute("aria-checked")).toBe(
    "true",
  );
});

test("an isolated Bot's Visibility row says, before it is made public and while it is, that everyone who uses it shares its computer", async () => {
  serve(MANAGED, actor.id, { isolated: true });
  const view = draw();
  expect(
    await view.findByText(
      `Only you can see it and start conversations with it. ${ISOLATED_MAKING_PUBLIC}`,
    ),
  ).toBeTruthy();
  cleanup();

  serve(MANAGED, actor.id, { isolated: true, visibility: "public" });
  const shared = draw();
  expect(
    await shared.findByText(
      `Everyone on OpenBot can find and use it. ${ISOLATED_PUBLIC_SHARES_LOGINS}`,
    ),
  ).toBeTruthy();
  cleanup();

  // A Bot on its person's computer has nothing of its own to share, so nothing more is said.
  serve(MANAGED, actor.id, { visibility: "public" });
  const plain = draw();
  expect(
    await plain.findByText("Everyone on OpenBot can find and use it."),
  ).toBeTruthy();
});

test("other edits leave Isolated alone", async () => {
  serve(MANAGED, actor.id, { isolated: true });
  const view = draw();
  await rename(view, "Receipts");
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).not.toHaveProperty("isolated");
});

test("a deployment that cannot make a second computer shows the row disabled, and says why", async () => {
  serve(MANAGED, actor.id, { isolationAvailable: false });
  const view = draw();
  const toggle = await isolatedSwitch(view);
  expect(toggle.hasAttribute("data-disabled")).toBe(true);
  expect(view.getByText(ISOLATION_UNAVAILABLE)).toBeTruthy();
});

test("somebody an admin has not allowed sees the row disabled, and why", async () => {
  mayIsolate = false;
  serve(MANAGED);
  const view = draw();
  expect(await view.findByText(ISOLATION_NOT_ALLOWED)).toBeTruthy();
  expect((await isolatedSwitch(view)).hasAttribute("data-disabled")).toBe(true);
});

/**
 * An isolated Bot whose owner's switch an administrator withdrew.
 *
 * The server decides this from the owner's switch as it is now (`isolated-bots.integration.test.ts`
 * pins that it answers `isolationOffReason: "admin"`); this serves that answer, in the route's own
 * shape, so the row can be held to what it says about it. The routes cannot be mounted here for it:
 * the verdict needs the enterprise controls, which need a database.
 */
test("an isolated Bot whose owner lost the switch says the admin turned it off, and can still be turned off", async () => {
  mayIsolate = false;
  let agent = {
    id: "expenses",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    visibility: "private",
    hidden: false,
    pinned: false,
    systemOwned: false,
    endpoint: MANAGED,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: true,
    canManage: true,
    mine: true,
    assignedToMe: false,
    builtIn: true,
    isolationActive: false,
    isolationOffReason: "admin" as "admin" | null,
  };
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path === "/api/admin/enterprise/me") return me();
      if (path === "/api/agents/capabilities") {
        return Response.json({
          capabilities: { builtInAvailable: true, isolationAvailable: true },
        });
      }
      if (path === "/api/agents/expenses" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        updates.push(body);
        agent = {
          ...agent,
          isolated: body.isolated,
          isolationOffReason: null,
        };
        return Response.json({ agent });
      }
      if (path === "/api/agents/expenses") return Response.json({ agent });
      throw new Error(`unexpected ${String(path)}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();

  expect(await view.findByText(ISOLATION_WITHDRAWN)).toBeTruthy();
  const toggle = await isolatedSwitch(view);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.hasAttribute("data-disabled")).toBe(false);

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(toggle);
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ isolated: false });
});

/*
 * The starter's subtitle reads the new wording wherever it is drawn, and stays stored as seeded:
 * the Bot is told the stored subtitle. Every in-place edit sends the whole profile back, so the
 * shown wording must never be what goes back unless the person rewrote it.
 */
test("the starter's subtitle shows the new wording, and an edit sends back the stored one", async () => {
  const stored = "Everyday life. Powered by LangChain (LangGraph).";
  const shown =
    "Everyday life agent. (powered by a LangChain agent; you can bring your own agent from any stack.)";
  serve(PICKED, actor.id, { title: stored });
  const view = draw("personal");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  const titled = await view.findByRole("button", { name: /^Title/ });
  expect(titled.textContent).toContain(shown);
  expect(titled.textContent).not.toContain("LangGraph");

  // Another field's edit carries the subtitle as stored.
  await rename(view, "Assistant");
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ name: "Assistant", title: stored });

  // The subtitle's own dialog shows the new wording; saved unchanged, it stays as stored.
  await user.click(view.getByRole("button", { name: /^Title/ }));
  await view.findByDisplayValue(shown);
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(updates).toHaveLength(2));
  expect(updates[1]).toMatchObject({ title: stored });
});
