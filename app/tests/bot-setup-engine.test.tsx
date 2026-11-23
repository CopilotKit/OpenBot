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
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { SetupSections } from "@/components/bot-profile/setup";
import type { AgentProfile } from "@/lib/agents/queries";
import { DEPLOYMENT_PATH, deploymentResponse } from "./admin-settings-api";

/**
 * What runs a Bot is not the person's concern: a Bot that runs inside OpenBot has no Connection
 * section on its Setup, whichever engine OpenBot runs it on. Only a Bot connected to an agent at an
 * address has one (bot-setup-agent-url.test.tsx).
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

test("a Bot that runs inside OpenBot has no Connection section, whichever engine runs it", async () => {
  for (const framework of ["LangGraph (TypeScript)", "OpenBot", undefined]) {
    const view = draw(<SetupSections agent={{ ...BOT, framework }} />);
    expect(await view.findByRole("button", { name: /^Name/ })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Connection" })).toBeNull();
    expect(view.queryByText("Built in")).toBeNull();
    expect(view.queryByText("Runs on")).toBeNull();
    cleanup();
  }
});
