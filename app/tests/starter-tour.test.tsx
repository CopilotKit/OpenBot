import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { STARTER_SUGGESTIONS } from "@/components/starter-tour/suggestions";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Preferences = {
  starterTourChannelId?: string;
};
function server(initial: Preferences = {}, available = true) {
  const users: Record<string, Preferences> = { first: initial, second: {} };
  const state = { userId: "first", failSave: false, patches: [] as unknown[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/me"))
      return Response.json({
        user: {
          id: state.userId,
          email: "person@example.com",
          role: "admin",
          onboarding: { completedAt: "2026-01-01", step: 3 },
        },
      });
    if (path.endsWith("/api/settings/preferences")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        state.patches.push(patch);
        if (state.failSave)
          return Response.json(
            { error: "Could not save starter tasks" },
            { status: 500 },
          );
        users[state.userId] = { ...users[state.userId], ...patch };
      }
      return Response.json({ preferences: users[state.userId] });
    }
    if (path.endsWith("/api/capabilities"))
      return Response.json({ generativeUi: available });
    if (path.endsWith("/api/setup"))
      return Response.json({
        checklist: {
          audience: "admin",
          rows: [{ id: "computer", ready: available }],
        },
      });
    throw new Error(`Unexpected HTTP request: ${path}`);
  }) as typeof fetch;
  return state;
}

function draw(
  props: {
    agentId: string | undefined;
    channelId?: string;
    disabled?: boolean;
    onSelect?: (message: string) => unknown;
  },
  existing?: QueryClient,
) {
  const client =
    existing ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  if (!existing) clients.push(client);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <StarterSuggestions onSelect={() => {}} {...props} />,
    }),
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    client,
  };
}

for (const agentId of ["picked-harness", "personal-assistant"]) {
  test(`${agentId}: an existing user with no tour preference can send each real SDK suggestion`, async () => {
    server();
    const sent: string[] = [];
    const view = draw({
      agentId,
      onSelect: (message) => {
        sent.push(message);
      },
    });
    for (const suggestion of STARTER_SUGGESTIONS) {
      const button = await view.findByRole("button", {
        name: suggestion.title,
      });
      await settleReactWork();
      fireEvent.click(button);
      await waitFor(() => expect(sent.at(-1)).toBe(suggestion.message));
    }
    expect(sent).toHaveLength(5);
  });
}

test("unrelated Bots never render the starter tasks", async () => {
  server();
  const view = draw({ agentId: "custom-bot" });
  await settleReactWork();
  expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull();
});

test("a claimed tour is shown only in its saved channel, never home or a later channel", async () => {
  server({ starterTourChannelId: "first-channel" });
  const saved = draw({ agentId: "picked-harness", channelId: "first-channel" });
  expect(
    await saved.findByRole("region", { name: "Starter tasks" }),
  ).toBeTruthy();
  saved.unmount();
  for (const channelId of [undefined, "later-channel"]) {
    const view = draw(
      { agentId: "personal-assistant", channelId },
      saved.client,
    );
    await settleReactWork();
    expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull();
    view.unmount();
  }
});

test("starter tasks have no dismiss control", async () => {
  server();
  const view = draw({ agentId: "picked-harness" });
  await view.findByRole("region", { name: "Starter tasks" });
  expect(view.queryByRole("button", { name: "Hide starter tasks" })).toBeNull();
  expect(view.getAllByRole("button")).toHaveLength(5);
});

test("one user's claimed conversation does not hide tasks for a second user in the same cache", async () => {
  const state = server({ starterTourChannelId: "first-channel" });
  const first = draw({ agentId: "picked-harness" });
  await waitFor(() =>
    expect(
      first.client.getQueryData(["settings", "preferences", "first"]),
    ).toBeTruthy(),
  );
  first.unmount();
  state.userId = "second";
  first.client.removeQueries({ queryKey: authKeys.currentUser() });
  const second = draw({ agentId: "personal-assistant" }, first.client);
  expect(
    await second.findByRole("region", { name: "Starter tasks" }),
  ).toBeTruthy();
});

test("busy and repeated presses do not send another message", async () => {
  server();
  let sends = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disabled = draw({
    agentId: "picked-harness",
    disabled: true,
    onSelect: () => {
      sends++;
    },
  });
  fireEvent.click(
    await disabled.findByRole("button", { name: STARTER_SUGGESTIONS[0].title }),
  );
  expect(sends).toBe(0);
  disabled.unmount();
  const view = draw({
    agentId: "picked-harness",
    onSelect: () => {
      sends++;
      return pending;
    },
  });
  const button = await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[0].title,
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(sends).toBe(1);
  release();
  await settleReactWork();
});

test("a failed selection leaves an error and permits retry", async () => {
  server();
  let sends = 0;
  const view = draw({
    agentId: "picked-harness",
    onSelect: async () => {
      if (++sends === 1) throw new Error("Task could not start. Try again.");
    },
  });
  const button = await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[0].title,
  });
  fireEvent.click(button);
  expect((await view.findByRole("alert")).textContent).toContain("Try again");
  fireEvent.click(button);
  await waitFor(() => expect(sends).toBe(2));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
});

test("disabled interactive answers explain the limitation without an irrelevant setup link", async () => {
  server({}, false);
  const sent: string[] = [];
  const view = draw({
    agentId: "picked-harness",
    onSelect: (message) => sent.push(message),
  });
  const button = await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[1].title,
  });
  await waitFor(() =>
    expect(
      view.client.getQueryData(["deployment", "capabilities"]),
    ).toBeTruthy(),
  );
  fireEvent.click(button);
  expect((await view.findByRole("alert")).textContent).toContain(
    "disabled for this installation",
  );
  expect(view.queryByRole("link", { name: "Check setup" })).toBeNull();
  expect(sent).toEqual([]);
});

for (const status of ["not_checked", "needs_setup", "request_failed"]) {
  for (const index of [3, 4]) {
    test(`browser task ${index} sends despite stale or failed checklist: ${status}`, async () => {
      server({}, false);
      const sent: string[] = [];
      const view = draw({
        agentId: "personal-assistant",
        onSelect: (message) => sent.push(message),
      });
      await act(async () => {
        view.client.setQueryData(
          ["setup", "checklist"],
          status === "request_failed"
            ? undefined
            : {
                audience: "admin",
                rows: [{ id: "computer", status, ready: false }],
              },
        );
      });
      fireEvent.click(
        await view.findByRole("button", {
          name: STARTER_SUGGESTIONS[index].title,
        }),
      );
      await waitFor(() =>
        expect(sent).toEqual([STARTER_SUGGESTIONS[index].message]),
      );
      expect(view.queryByRole("alert")).toBeNull();
    });
  }
}
