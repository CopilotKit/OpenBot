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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route as ComposioRoute } from "@/routes/_authed/admin/plugins/composio";
import { APPS_PATH, answerAppsApi, appBody } from "./apps-api";

/**
 * WHAT A FAILED ADD SAYS WHEN A SECOND ADD IS PRESSED BEFORE THE FIRST ONE ANSWERS.
 *
 * ONE MUTATION OBSERVER SERVES EVERY ROW on this screen — the list is a few hundred apps and a
 * `useMutation` per row would be a few hundred observers — and the screen reads that observer for
 * everything: `enable.isPending` and `enable.variables` to decide which row says "Adding…", and
 * `enable.error` for the banner. The first two are correct; the third is not, and for the same
 * reason the first two work. React Query's `MutationObserver.mutate` does
 * `this.#currentMutation?.removeObserver(this)` and rebuilds, so every field on the observer
 * describes ONLY the most recent press.
 *
 * SO A SECOND ADD SILENTLY DISCARDED THE FIRST APP'S REFUSAL. An administrator pressing Add on
 * Slack and then, a beat later, on Gmail watched Slack's row revert from "Adding…" to "Add" with
 * its request still in flight — and when Slack came back 409, or 503, or carrying Composio's own
 * sentence about a bad key, the banner never showed it, because `enable.error` was Gmail's and
 * Gmail's was null. What was left was a row saying "Add" and no record that anything had failed.
 *
 * THE FIX IS THE SHAPE THE SIBLING GRANT SCREEN ALREADY USES (`$key_.bots.$agentId.tsx:98`): the
 * mutation-level `options.onError` still fires after `removeObserver`, so the sentence is kept in
 * the screen's own state rather than read back off an observer that has moved on.
 *
 * THE HARNESS IS THIS REPOSITORY'S, from `agent-roster-error.test.tsx`: `GlobalRegistrator` in
 * `beforeAll`/`afterAll`, `cleanup` in `afterEach`, queries off `render()`'s own return, and a
 * `QueryClient` with `retry: false`. The `fetch` here is a small stateful stub rather than one
 * canned response, because the whole property is a SEQUENCE — a slow failure overtaken by a fast
 * success — and a stub that answered both presses identically could not express it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLACK_REFUSAL = "Composio would not take this deployment's key.";

/** Releases whatever the Slack add is waiting on. Set by the stub, called by the test. */
let releaseSlack: () => void = () => undefined;

beforeEach(() => {
  const slackWaits = new Promise<void>((resolve) => {
    releaseSlack = resolve;
  });

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = typeof input === "string" ? input : String(input);
    const path = requested.split("?")[0] ?? requested;
    const json = (body: unknown, status = 200, type = "application/json") =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": type },
      });

    if (path === APPS_PATH && init?.method === "POST") {
      const { directoryEntryId } = JSON.parse(String(init.body)) as {
        directoryEntryId: string;
      };
      const slug = directoryEntryId.replace(/^directory:/, "");
      if (slug === "slack") {
        // HELD, so the second press genuinely overtakes the first rather than following it. This is
        // the window the defect lives in and the only way a test can stand inside it.
        await slackWaits;
        return json(
          {
            type: "https://open.bot/errors/app-service-failed",
            title: "The service behind this app didn't answer.",
            status: 502,
            detail: SLACK_REFUSAL,
            code: "APP_SERVICE_FAILED",
            category: "dependency",
            retryable: true,
            requestId: "req_test",
            traceId: "trace_test",
          },
          502,
          "application/problem+json",
        );
      }
      // The API's own answer: the app it added.
      return json(
        appBody({
          id: `composio-${slug}`,
          title: slug,
          url: `composio://${slug}`,
          provenance: "composio",
          authScheme: "OAUTH2",
        }),
        201,
      );
    }
    // Every read this screen and its invalidation make.
    const apps = answerAppsApi(input, init, {
      composioConfigured: true,
      directory: [
        {
          slug: "slack",
          name: "Slack",
          description: "Messages, channels and files.",
          logo: null,
          categories: [],
          actionCount: 167,
          // Slack and Gmail are both sign-in apps.
          connection: { kind: "consent" },
          enabled: false,
        },
        {
          slug: "gmail",
          name: "Gmail",
          description: "Mail, threads and labels.",
          logo: null,
          categories: [],
          actionCount: 42,
          connection: { kind: "consent" },
          enabled: false,
        },
      ],
    });
    if (apps) return apps;
    return json({ connections: [] });
  }) as unknown as typeof fetch;
});

/*
 * Capture and restore of the exported `Route` singleton, verbatim from `agent-roster-error.test.tsx`
 * and `brokered-account-row.test.tsx` and for the reason recorded there: `.update()` merges into the
 * live object, `createRouter()` derives `_id`/`parentRoute` off it, and nothing re-runs `init()` on
 * a replay — so a render here would otherwise leave the real router pointed at a decoy parent.
 */
const originalOptions = { ...ComposioRoute.options };
afterEach(() => {
  Object.assign(ComposioRoute.options, originalOptions);
});

function renderPicker() {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const wired = (
    ComposioRoute as unknown as {
      update: (options: unknown) => typeof ComposioRoute;
    }
  ).update({
    id: "/plugins/composio",
    path: "/plugins/composio",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: ["/admin/plugins/composio"],
    }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an add that fails while a second one is pressed still says what went wrong", async () => {
  const view = renderPicker();

  // Both rows, in the order the screen sorts them: Gmail then Slack.
  // `directory-…`, not `composio-…`: one provider-blind screen draws both brokers' directories.
  const slackRow = await view.findByTestId("directory-slack");
  const gmailRow = await view.findByTestId("directory-gmail");

  // The press that will fail, held open by the stub.
  await userEvent.click(
    await within(slackRow).findByRole("button", { name: "Add" }),
  );
  // And the press that overtakes it, which rebuilds the shared observer under the first one.
  await userEvent.click(
    await within(gmailRow).findByRole("button", { name: "Add" }),
  );

  /*
   * AND SLACK'S ROW IS STILL "ADDING…", which is the other half of the same defect. Read off the
   * observer, `enable.variables` names Gmail by now, so Slack's row put itself back to "Add" with
   * its request still open — an invitation to press it again, which asks the server to enable an app
   * it is already enabling.
   */
  expect(
    within(slackRow)
      .getByRole("button", { name: "Adding…" })
      .hasAttribute("disabled"),
  ).toBe(true);

  // Now let Slack's request answer, long after the observer stopped describing it.
  releaseSlack();

  await waitFor(() => {
    expect(view.getByRole("alert").textContent).toContain(SLACK_REFUSAL);
  });

  // And the row drains on the refusal exactly as it would on a success, so a retry is possible.
  await waitFor(() => {
    expect(within(slackRow).getByRole("button", { name: "Add" })).toBeTruthy();
  });
});
