import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResponsibilityDialog } from "@/components/responsibilities/responsibility-dialog";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const sent: { method: string; url: string; body: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          method,
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({});
      }
      return Response.json({ triggers: [], runs: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

const goal: ResponsibilityRecord = {
  id: "goal-1",
  agentId: "bot-1",
  channelId: "c1",
  threadId: "t1",
  title: "Watch the queue",
  instruction: "Tell me when the queue backs up.",
  successCriteria: "",
  status: "active",
  progress: "",
  lastResult: null,
  subscriptions: [],
  recurring: false,
  endsWhenMet: false,
  updatedAt: "2026-11-10T10:00:00Z",
};

const ENDS_WHEN_MET_ERROR =
  "It ends when this is met, so say what done looks like.";

function renderDialog(
  record: ResponsibilityRecord,
  onClose: () => void = () => {},
) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => (
          <ResponsibilityDialog goal={record} onClose={onClose} />
        ),
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a goal with no outcome can be saved after changing only its title", async () => {
  let closed = 0;
  const view = renderDialog(goal, () => {
    closed += 1;
  });
  const criteria = (await view.findByLabelText(
    "Success criteria",
  )) as HTMLTextAreaElement;
  expect(criteria.getAttribute("aria-required")).toBeNull();
  expect(criteria.value).toBe("");
  const user = userEvent.setup({ document });
  const title = view.getByLabelText("Title");
  await user.clear(title);
  await user.type(title, "Watch the support queue");
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sent.length).toBe(1));
  expect(sent[0]).toEqual({
    method: "PATCH",
    url: "/api/responsibilities/goal-1",
    body: {
      title: "Watch the support queue",
      instruction: "Tell me when the queue backs up.",
      successCriteria: "",
    },
  });
  await waitFor(() => expect(closed).toBe(1));
  expect(view.queryByText(ENDS_WHEN_MET_ERROR)).toBeNull();
  expect(criteria.getAttribute("aria-invalid")).toBeNull();
});

test("a goal that ends when met can't have its outcome cleared", async () => {
  let closed = 0;
  const view = renderDialog(
    { ...goal, endsWhenMet: true, successCriteria: "X" },
    () => {
      closed += 1;
    },
  );
  const criteria = (await view.findByLabelText(
    "Success criteria",
  )) as HTMLTextAreaElement;
  const user = userEvent.setup({ document });
  await user.click(criteria);
  await user.keyboard("{Backspace}");
  expect(criteria.getAttribute("aria-required")).toBe("true");
  expect(criteria.value).toBe("");
  await user.click(view.getByRole("button", { name: "Save" }));
  await view.findByText(ENDS_WHEN_MET_ERROR);
  expect(criteria.getAttribute("aria-invalid")).toBe("true");
  expect(sent.length).toBe(0);
  expect(closed).toBe(0);
  // Typing an outcome clears the error and lets it save.
  await user.type(criteria, "Queue is empty");
  expect(view.queryByText(ENDS_WHEN_MET_ERROR)).toBeNull();
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sent.length).toBe(1));
  expect(sent[0]).toEqual({
    method: "PATCH",
    url: "/api/responsibilities/goal-1",
    body: {
      title: "Watch the queue",
      instruction: "Tell me when the queue backs up.",
      successCriteria: "Queue is empty",
    },
  });
  await waitFor(() => expect(closed).toBe(1));
});

test("a goal that ends when met treats whitespace-only criteria as blank", async () => {
  let closed = 0;
  const view = renderDialog(
    { ...goal, endsWhenMet: true, successCriteria: "X" },
    () => {
      closed += 1;
    },
  );
  const criteria = (await view.findByLabelText(
    "Success criteria",
  )) as HTMLTextAreaElement;
  const user = userEvent.setup({ document });
  await user.clear(criteria);
  await user.type(criteria, "   ");
  expect(criteria.value).toBe("   ");
  await user.click(view.getByRole("button", { name: "Save" }));
  await view.findByText(ENDS_WHEN_MET_ERROR);
  expect(criteria.getAttribute("aria-invalid")).toBe("true");
  expect(sent.length).toBe(0);
  expect(closed).toBe(0);
});

test("a goal that ends when met saves normally when it has an outcome", async () => {
  let closed = 0;
  const view = renderDialog(
    { ...goal, endsWhenMet: true, successCriteria: "X" },
    () => {
      closed += 1;
    },
  );
  const user = userEvent.setup({ document });
  const title = await view.findByLabelText("Title");
  await user.clear(title);
  await user.type(title, "Watch the support queue");
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sent.length).toBe(1));
  expect(sent[0]?.body).toEqual({
    title: "Watch the support queue",
    instruction: "Tell me when the queue backs up.",
    successCriteria: "X",
  });
  await waitFor(() => expect(closed).toBe(1));
  expect(view.queryByText(ENDS_WHEN_MET_ERROR)).toBeNull();
});
