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
import { WEB_HARNESSES } from "@openbot/shared/harnesses";
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
 * "Where does it run?" as buttons rather than two radios.
 *
 * The person this step is for arrives knowing the role they want and little else, and could not
 * tell Built-in from Managed. It now leads with the Bot this deployment runs itself, and lists the
 * frameworks somebody might already be using by name and mark, so the answer is recognised rather
 * than deduced.
 *
 * Mastra is deliberately absent. The server reaches it as `remote_mastra` through the
 * `@ag-ui/mastra` bridge and needs a roster id to say which agent it means; the create endpoint can
 * send neither, so a Mastra row here would make a Bot that appears, accepts a grant, and answers
 * nothing. `shared/harnesses.json` carries that as `webCreate: false`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let builtInAvailable = true;

beforeEach(() => {
  builtInAvailable = true;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      if (path === "/api/agents/capabilities") {
        return Response.json({ capabilities: { builtInAvailable } });
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

/** Fill in who the coworker is and move on, which is the only way to reach this step. */
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

test("leads with the Bot this deployment runs itself", async () => {
  const { view } = await atKindStep();
  expect(view.getByRole("button", { name: /Run it here/ })).toBeTruthy();
});

test("shows every offerable framework at once, behind no disclosure", async () => {
  const { view } = await atKindStep();
  expect(view.getAllByTestId("harness-option")).toHaveLength(
    WEB_HARNESSES.length,
  );
  expect(view.queryByTestId("harness-more")).toBeNull();
});

/*
 * The list is what scrolls, not the step: bounding it is what keeps the question above it and the
 * Back button below it where they were when the step was drawn.
 */
/*
 * The step is drawn inside a frame that animates its height and hides its overflow — on BOTH axes.
 * Anything wider than that frame can be scrolled into view sideways, and when it is, every child
 * draws to the left of where it belongs: the heading loses the left of its first letter and each
 * row loses its left border. This asserts the width, which is the property that actually broke,
 * rather than a class name on a wrapper.
 */
test("puts nothing inside the step wider than the frame that clips it", async () => {
  const { view } = await atKindStep();
  const frame = view.baseElement.querySelector(".relative.overflow-hidden");
  expect(frame).toBeTruthy();
  expect((frame as HTMLElement).scrollWidth).toBeLessThanOrEqual(
    (frame as HTMLElement).clientWidth,
  );
});

test("a framework with no vendored mark still names itself", async () => {
  const { view } = await atKindStep();
  expect(view.getByRole("button", { name: /Agno/ })).toBeTruthy();
});

test("never offers Mastra, which this create path cannot make work", async () => {
  const { view } = await atKindStep();
  expect(view.queryByRole("button", { name: /Mastra/ })).toBeNull();
});

test("offers Run it here only where the deployment has a Bot of its own", async () => {
  builtInAvailable = false;
  const { view } = await atKindStep();
  expect(
    view.getByRole("button", { name: /Run it here/ }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view.getByRole("button", { name: /CrewAI/ }).hasAttribute("disabled"),
  ).toBe(false);
});

/*
 * The defect this replaced read as "there isn't one" when the truth is that nobody has switched it
 * on. Worded for the person in front of the dialog, who is not the person who can fix it.
 */
test("says the Bot can be switched on, not that none exists", async () => {
  builtInAvailable = false;
  const { view } = await atKindStep();
  expect(
    view.getByRole("button", { name: /Run it here/ }).textContent,
  ).toContain("switch this on");
});

test("choosing a framework moves straight on, with no Continue to press", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /CrewAI/ }));
  expect(await view.findByLabelText("Agent endpoint")).toBeTruthy();
});

test("choosing Run it here moves straight on too", async () => {
  const { view, user } = await atKindStep();
  await user.click(view.getByRole("button", { name: /Run it here/ }));
  expect(await view.findByText("Who can see it?")).toBeTruthy();
});
