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
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SetupSections } from "@/components/bot-profile/setup";
import type { AgentProfile } from "@/lib/agents/queries";
import { DEPLOYMENT_PATH, deploymentResponse } from "./admin-settings-api";

/**
 * A Bot's Setup says what runs it. A Bot made from New Bot runs inside OpenBot on the LangGraph
 * (TypeScript) engine, and the Bot API names that as its framework; its Connection says so, under
 * "Built in", so a person can see which engine answers. A Bot that runs on OpenBot's own agent, as
 * every Bot made before does, shows "Built in" alone.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) =>
      path === DEPLOYMENT_PATH
        ? deploymentResponse({ builtInBots: true })
        : new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "tide-table-clerk",
  name: "Tide Table Clerk",
  title: "Powered by OpenBot",
  roleDescription: "You answer questions about harbours.",
  avatarSeed: "tide-table-clerk",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** The Setup sections inside a router of one route, for the links they hold. */
function draw(screen: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function connection(bot: AgentProfile) {
  const view = draw(<SetupSections agent={bot} />);
  const heading = await view.findByRole("heading", { name: "Connection" });
  const section = heading.closest("section") ?? heading.parentElement;
  if (!section) throw new Error("no Connection section");
  return within(section as HTMLElement);
}

test("a Bot on the LangGraph (TypeScript) engine names it under Built in", async () => {
  const section = await connection({
    ...BOT,
    framework: "LangGraph (TypeScript)",
  });
  expect(section.getByText("Built in")).toBeTruthy();
  expect(section.getByText("Runs on")).toBeTruthy();
  expect(
    section.getByText("LangGraph (TypeScript)", { exact: true }),
  ).toBeTruthy();
});

test("a Bot on OpenBot's own agent shows Built in alone", async () => {
  for (const framework of ["OpenBot", undefined]) {
    const section = await connection({ ...BOT, framework });
    expect(section.getByText("Built in")).toBeTruthy();
    expect(section.queryByText("Runs on")).toBeNull();
    cleanup();
  }
});
