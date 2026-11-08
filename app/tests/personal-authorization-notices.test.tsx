import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { deploymentKeys } from "@/lib/deployment/queries";
import { identityKeys } from "@/lib/identity/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { Route } from "@/routes/_authed/_app/connections.index";
import { settleReactWork } from "./settle-react-work";

/*
 * Three of the notices the Connections page draws when an authorization comes back sent the reader
 * to an admin: "Ask an admin to set it up", "Ask an admin if you expected to finish it", "or ask an
 * admin if it keeps happening". The personal edition has one person and no admin, so it says what
 * that person does instead. This draws the real page, arriving with each code, in both editions.
 */

const PATH = "/connections";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
beforeAll(() => {
  // Everything the page reads is seeded; anything else is not served.
  global.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

function arrive(edition: "team" | "personal", code: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  queryClient.setQueryData(pluginKeys.page(), { servers: [], catalogue: [] });
  queryClient.setQueryData(pluginKeys.connections(), { connections: [] });
  queryClient.setQueryData(identityKeys.links(), []);
  queryClient.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const screen = Route.update({
    id: PATH,
    path: PATH,
    getParentRoute: () => root,
  } as never);
  const router = createRouter({
    routeTree: root.addChildren([screen]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [`${PATH}?authorized=${code}`],
    }),
  } as never) as never;
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function noticeOf(view: ReturnType<typeof arrive>): Promise<string> {
  return (await view.findByRole("alert")).textContent ?? "";
}

const PERSONAL: Record<string, string> = {
  "no-broker":
    "Connecting apps isn't set up yet, so nothing was recorded. Set it up in Settings under Setup.",
  "not-permitted":
    "You can't connect that app's account anymore, so nothing was recorded. The app's setup changed while the authorization was open. Start again from the app's page.",
  "not-recorded":
    "Couldn't record that authorization, so nothing was saved. Start again from the app's page, or check OpenBot's logs if it keeps happening.",
};

const TEAM: Record<string, string> = {
  "no-broker":
    "Connecting apps isn't set up yet, so nothing was recorded. Ask an admin to set it up.",
  "not-permitted":
    "You can't connect that app's account anymore, so nothing was recorded. Your access or the app's setup changed while the authorization was open. Ask an admin if you expected to finish it.",
  "not-recorded":
    "Couldn't record that authorization, so nothing was saved. Start again from the app's page, or ask an admin if it keeps happening.",
};

for (const code of Object.keys(PERSONAL)) {
  test(`?authorized=${code} in personal says what you do, and names no admin`, async () => {
    const notice = await noticeOf(arrive("personal", code));
    expect(notice).toBe(PERSONAL[code] as string);
    expect(notice).not.toMatch(/admin|deployment/i);
  });

  test(`?authorized=${code} in team keeps its words`, async () => {
    expect(await noticeOf(arrive("team", code))).toBe(TEAM[code] as string);
  });
}

test("a code whose sentence names no admin reads the same in personal", async () => {
  expect(await noticeOf(arrive("personal", "no-attempt"))).toBe(
    "There's no authorization in progress for you to finish. It may have expired, or started in another session. Start again from the app's page.",
  );
});
