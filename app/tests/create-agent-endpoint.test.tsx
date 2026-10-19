import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { settleReactWork } from "./settle-react-work";

/*
 * `import.meta.glob` is Vite's, and `bun test` has no Vite. Stubbed the way the desktop stubs its
 * own marks module, keeping the shape that matters here: a brand with a vendored mark resolves to
 * something drawable, and one without resolves to null so its row shows the name alone.
 */
mock.module("@/lib/marks", () => ({
  markFor: (id: string | null | undefined) =>
    id ? `data:image/svg+xml,${id}` : null,
}));

/*
 * Imported after the stub above, not beside the other imports: a static import is hoisted
 * and would evaluate the real marks module — and its Vite-only glob — before `mock.module`
 * ever ran.
 */
const { CreateAgentDialog } = await import(
  "@/components/agents/create-agent-dialog"
);

/**
 * The AG-UI endpoint, on a step of its own.
 *
 * It is generic: every framework leads here and none of them changes a word of it. The step exists
 * only for a Bot somebody else hosts, so the Bot that runs on this deployment never sees it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
/** Every write the dialog sent, so "the endpoint was discarded" is an assertion. */
let writes: { request: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  writes = [];
  global.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method ?? "GET";
      if (path === "/api/agents/capabilities") {
        return Response.json({ capabilities: { builtInAvailable: true } });
      }
      if (method === "POST" && String(path).startsWith("/api/agents")) {
        writes.push({
          request: `${method} ${path}`,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
        });
        return Response.json({ agent: { id: "expense-manager" } });
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

async function atKindStep() {
  const view = draw(
    <CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />,
  );
  const name = await view.findByLabelText("Name");
  const user = userEvent.setup({ document: name.ownerDocument });
  await user.type(name, "Expense Manager");
  await user.type(view.getByLabelText("Title"), "Finance Operations");
  await user.type(view.getByLabelText("What it does"), "Review receipts.");
  await user.click(view.getByText("Continue"));
  await view.findByText("Where does it run?");
  return { view, user };
}

test("a framework leads to one generic endpoint step", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /CrewAI/ }));
  const field = await view.findByLabelText("Agent endpoint");
  expect(field).toBeTruthy();
  /*
   * Generic: the framework that led here is not named on it. Scoped to this step's own pane
   * rather than the popup, because the pane being slid out is still mounted mid-animation and
   * carries the name of the button that was just pressed.
   */
  const pane = view
    .getByText("Where can it be reached?")
    .closest('[data-slot="questionnaire-item"]');
  expect(pane?.textContent).not.toContain("CrewAI");
});

test("the Bot that runs here skips the endpoint step entirely", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /Run it here/ }));
  expect(await view.findByText("Who can see it?")).toBeTruthy();
  expect(view.queryByLabelText("Agent endpoint")).toBeNull();
});

test("going back keeps the framework that was chosen", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /CrewAI/ }));
  await view.findByLabelText("Agent endpoint");
  await user.click(view.getByText("Back"));
  const chosen = await view.findByRole("button", { name: /CrewAI/ });
  expect(chosen.getAttribute("aria-pressed")).toBe("true");
});

/*
 * Review Focus: an endpoint typed on the way past must not ride along into a Bot that runs here.
 * The server stores whatever it is sent, and a built-in Bot carrying somebody's stale URL would be
 * dialled at it.
 */
test("choosing Run it here discards an endpoint typed earlier", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /CrewAI/ }));
  await user.type(
    await view.findByLabelText("Agent endpoint"),
    "https://example.com/ag-ui",
  );
  await user.click(view.getByText("Back"));
  await user.click(view.getByRole("button", { name: /Run it here/ }));
  await view.findByText("Who can see it?");
  await user.click(view.getByText("Create coworker"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body.endpoint).toBe("");
});

test("Enter in the endpoint field advances the step", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /CrewAI/ }));
  const field = await view.findByLabelText("Agent endpoint");
  await user.type(field, "https://example.com/ag-ui");
  await act(async () => {
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
  });
  expect(await view.findByText("Who can see it?")).toBeTruthy();
});
