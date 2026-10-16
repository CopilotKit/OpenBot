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
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { settleReactWork } from "./settle-react-work";

/**
 * The order the wizard asks its questions in, and the counter it no longer draws.
 *
 * Visibility used to be the second question, asked before the person had decided anything that
 * makes it meaningful. It is now the last. The "Step 1 of 3" line went with the reorder rather than
 * despite it: the wizard is three steps for a Bot that runs here and four for one at an address, and
 * a counter that changes its own total mid-way is worse than no counter.
 *
 * Harness is this repository's: `GlobalRegistrator` around the file, `cleanup` after each, a
 * `QueryClient` with `retry: false`, and the real component inside a router of one route.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
/*
 * Drain React's scheduler before the document goes away: `cleanup` unmounts, but it does not
 * retract a callback the scheduler has already posted, and one firing after `unregister()` reports
 * as "Unhandled error between tests" with zero failing tests and a non-zero exit.
 */
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      if (path === "/api/agents/capabilities") {
        return Response.json({ capabilities: { builtInAvailable: true } });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

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

function dialog() {
  return draw(
    <CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />,
  );
}

async function fillIdentity(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({
    document: (await view.findByLabelText("Name")).ownerDocument,
  });
  await user.type(view.getByLabelText("Name"), "Expense Manager");
  await user.type(view.getByLabelText("Title"), "Finance Operations");
  await user.type(view.getByLabelText("What it does"), "Review receipts.");
  return user;
}

test("asks where it runs straight after who it is, not who can see it", async () => {
  const view = dialog();
  const user = await fillIdentity(view);
  await user.click(view.getByText("Continue"));
  expect(await view.findByText("Where does it run?")).toBeTruthy();
  expect(view.queryByText("Who can see it?")).toBeNull();
});

/*
 * Asserted against the popup's whole text rather than with `queryByText`: the counter was built as
 * `Step {step + 1} of {STEPS.length}`, which React renders as four separate text nodes, and a
 * regex matcher walks nodes one at a time and never sees it. The first version of this test passed
 * against the counter it was written to forbid.
 */
test("never draws a step counter", async () => {
  const view = dialog();
  await view.findByLabelText("Name");
  const popup = view.baseElement.querySelector('[data-slot="dialog-content"]');
  expect(popup?.textContent).not.toMatch(/Step \d+ of \d+/);
});
