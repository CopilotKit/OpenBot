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
import { AccessSections } from "@/components/bot-profile/access";
import type { AgentProfile } from "@/lib/agents/queries";
import type { AppAccess } from "@/lib/app-access/queries";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * Your apps, on a Bot you own: one switch per app you connected that an admin lets owners give.
 * Switching one on gives it; switching it off takes back what you gave; an app an admin gave stays
 * on and cannot be switched by you. Not drawn at all on somebody else's Bot.
 */

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

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
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

const GMAIL = {
  key: "composio-gmail",
  displayName: "Gmail",
  logo: null,
  account: "personal",
};
const NOTION = {
  key: "notion",
  displayName: "Notion",
  logo: null,
  account: "personal",
};

function serving(held: AppAccess[]) {
  const writes: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/give")) {
      writes.push(`${method} ${url}`);
      return Response.json({ granted: [], revoked: [] });
    }
    if (url === "/api/plugins/giveable")
      return Response.json({ apps: [GMAIL, NOTION] });
    if (url.includes("/api/plugins/for/") && url.endsWith("/apps"))
      return Response.json({ apps: held });
    if (url.includes("/api/plugins/for/"))
      return Response.json({ tools: [], skills: [] });
    if (url.endsWith("/api/plugins"))
      return Response.json({
        catalogue: [],
        servers: [],
        botsMayCallBack: true,
        redirectUri: null,
        skills: [],
      });
    if (url.includes("/handoff"))
      return Response.json({
        handoff: {
          enabled: true,
          canGrant: false,
          reachable: [],
          grantable: true,
        },
      });
    if (url.includes("/api/agents")) return Response.json({ agents: [] });
    return Response.json({
      user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
    });
  }) as unknown as typeof fetch;
  return writes;
}

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <AccessSections agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("each app you could give has a switch, on where you gave it, and pressing it gives or takes back", async () => {
  const writes = serving([
    appAccess({ key: "notion", displayName: "Notion", givenByOwner: true }),
  ]);
  const view = draw(BOT);
  const gmail = await view.findByRole("switch", {
    name: "Let Expenses use Gmail",
  });
  const notion = view.getByRole("switch", { name: "Let Expenses use Notion" });
  expect(gmail.getAttribute("aria-checked")).toBe("false");
  expect(notion.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText("Expenses can't use your Gmail.")).toBeTruthy();

  fireEvent.click(gmail);
  await waitFor(() =>
    expect(writes).toContain(
      "POST /api/plugins/for/expenses/apps/composio-gmail/give",
    ),
  );
  fireEvent.click(notion);
  await waitFor(() =>
    expect(writes).toContain(
      "DELETE /api/plugins/for/expenses/apps/notion/give",
    ),
  );
});

test("an app an admin gave this Bot is on, and not yours to switch off", async () => {
  serving([appAccess({ givenByOwner: false })]);
  const view = draw(BOT);
  const gmail = await view.findByRole("switch", {
    name: "Let Expenses use Gmail",
  });
  expect(gmail.getAttribute("aria-checked")).toBe("true");
  expect(
    gmail.hasAttribute("disabled") ||
      gmail.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(view.getByText("An admin gave it to this Bot.")).toBeTruthy();
});

test("somebody else's Bot has no Your apps section", async () => {
  serving([]);
  const view = draw({ ...BOT, mine: false });
  await view.findByText("What it can use");
  expect(view.queryByText("Your apps")).toBeNull();
});
