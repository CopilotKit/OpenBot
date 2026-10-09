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
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";

/**
 * The home screen reads `agentListQueryOptions()` and drew its empty state on a FAILED query, not
 * just an empty one: `isPending` goes false on failure exactly as it does on success, so a broken
 * fetch fell through to "you have nothing" and told somebody who may own twenty coworkers that they
 * own none. The Bots roster's own failure handling is pinned in `bot-roster.test.tsx`.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and queries off `render()`'s own return, matching `proposed-bot-card.test.tsx` for
 * the reason recorded there: bun walks every file into one process, and a document another file
 * tore down mid-run fails invisibly.
 *
 * Each test builds its own `QueryClient` with `retry: false` — the app's own client (see
 * `query-client.ts`) retries once, which is correct for production and would just slow this test
 * down for no assertion it needs.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  // Every read in this app goes through `client()` in `lib/client.ts`, which throws once the
  // response is not `ok`. A 500 with no body is the shape a broken server actually sends, and is
  // exactly what `client()`'s fallback message path exists for.
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client the failing query settles on in one attempt, so the test does not wait on a retry. */
function failingQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

/**
 * A client that already holds a successful `agents` list under the exact key
 * `agentListQueryOptions()` reads (`agentKeys.list(false)`, the default `hidden` param both
 * screens call it with), built on `failingQueryClient()` so the one refetch it triggers on mount
 * settles without a retry.
 *
 * Combined with the always-failing `global.fetch` this file's `beforeEach` installs, mounting a
 * screen against this client reproduces a failed BACKGROUND refetch: TanStack Query's default
 * `refetchOnMount` fires a fetch immediately because `staleTime` is unset (0), that fetch hits the
 * mocked 500, and `isError` becomes true while `data` — per query-core's error action, which
 * spreads `...state` and never touches `data` — stays exactly this seeded roster. No fake timers or
 * queryFn stand-in are needed: seeding the cache and letting the real, already-mocked fetch fail is
 * the whole scaffold.
 */
function staleQueryClient(agents: AgentProfile[]) {
  const queryClient = failingQueryClient();
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

/** A minimal but complete `AgentProfile`, overridable per test. */
function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    name: "Agent",
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/** Waits for the seeded query to have actually failed its background refetch, rather than trusting
 *  that the seeded data alone (which would render identically before any fetch ran) proves it. */
async function waitForFailedRefetch(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    );
  });
}

/**
 * `findByText`'s own default wait is 1000ms, and `/` mounts the heavy rich-text `Composer` on top
 * of the roster query, so a render on `/` is slow. Under load it crosses 1000ms and the default
 * times out around 1010ms — not a logic bug (data is never cleared or corrupted through the error
 * transition; this was checked with a `Profiler`), just too little headroom for a busy machine. Do
 * not remove this as a redundant-looking argument: every `findByText` in a test that renders `/`
 * needs it.
 */
const HOME_FIND_TIMEOUT = { timeout: 5000 };

/** `/`'s component makes no `Route.useSearch()` / `Route.useNavigate()` call of its own, so mounting
 *  it directly as a memory router's root is enough — no ancestor chain to reconstruct. */
function renderHome(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: HomeRoute.options.component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a failed roster on / reports the failure and explains the disabled composer", async () => {
  const view = renderHome(failingQueryClient());

  expect(
    await view.findByText(
      "Agents shared with you couldn't be loaded.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("Nobody has shared an agent with you yet."),
  ).toBeNull();

  // The composer goes `disabled={!fallback}` on the very same failure, with nothing on screen
  // saying why unless this alert renders.
  expect(
    await view.findByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
});

test("a failed REFETCH on / keeps the roster and does not disclaim the composer", async () => {
  const shared = agent({
    id: "shared-1",
    name: "Shared Agent",
    mine: false,
    visibility: "public",
  });
  const queryClient = staleQueryClient([shared]);

  const view = renderHome(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(
    await view.findByText("Shared Agent", {}, HOME_FIND_TIMEOUT),
  ).toBeTruthy();
  // Only renders while `fallback` is set, which the retained roster still supplies — the direct
  // evidence that the composer is not the disabled, nothing-to-send-to state its alert describes.
  expect(
    await view.findByText(
      "Sent to the coworker it is for.",
      { exact: false },
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
});

/*
 * A failed REFETCH can also land on cache that is ASYMMETRIC: one slice populated, its sibling
 * genuinely empty. `?.length` cannot tell "loaded, and this slice is empty" apart from "never
 * loaded" — both read as falsy — so gating the destructive arm on `failed` alone (once the
 * populated-list check above it doesn't fire) puts the "couldn't be loaded" card on the empty
 * sibling, right beside a section rendering real cards from that very same query. The real cards
 * are the proof: the response came back, and this slice of it is just empty.
 */
test("a failed REFETCH on / with explore empty shows it as empty, not broken", async () => {
  const mine = agent({ id: "mine-1", name: "Mine Agent", mine: true });
  const queryClient = staleQueryClient([mine]);

  const view = renderHome(queryClient);
  await waitForFailedRefetch(queryClient);

  expect(
    await view.findByText(
      "Nobody has shared an agent with you yet.",
      {},
      HOME_FIND_TIMEOUT,
    ),
  ).toBeTruthy();
  expect(
    view.queryByText("Agents shared with you couldn't be loaded."),
  ).toBeNull();
  // `agents` loaded (it holds "Mine Agent"), so `fallback` falls back to it and the composer is
  // enabled — the alert claiming a load failure must not appear beside that working composer.
  expect(
    view.queryByText(
      "Your coworkers couldn't be loaded, so there's no one to send this to yet.",
    ),
  ).toBeNull();
});
