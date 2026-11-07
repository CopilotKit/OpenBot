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
  starterTourDismissed?: boolean;
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

test("Hide PATCHes the shared account preference and remains hidden for both IDs after remount", async () => {
  const state = server();
  const view = draw({ agentId: "picked-harness" });
  fireEvent.click(
    await view.findByRole("button", { name: "Hide starter tasks" }),
  );
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull(),
  );
  expect(state.patches).toEqual([{ starterTourDismissed: true }]);
  view.unmount();
  for (const agentId of ["picked-harness", "personal-assistant"]) {
    const remount = draw({ agentId });
    await waitFor(() =>
      expect(
        remount.client.getQueryData<Preferences>([
          "settings",
          "preferences",
          "first",
        ]),
      ).toEqual({ starterTourDismissed: true }),
    );
    expect(remount.queryByRole("region", { name: "Starter tasks" })).toBeNull();
    remount.unmount();
  }
});

test("a dismissed user's preference does not hide tasks for a second user in the same cache", async () => {
  const state = server({ starterTourDismissed: true });
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

test("a failed dismissal keeps the choices visible and can be retried", async () => {
  const state = server();
  state.failSave = true;
  const view = draw({ agentId: "personal-assistant" });
  fireEvent.click(
    await view.findByRole("button", { name: "Hide starter tasks" }),
  );
  expect((await view.findByRole("alert")).textContent).toContain(
    "Could not save starter tasks",
  );
  expect(view.getByRole("region", { name: "Starter tasks" })).toBeTruthy();
  state.failSave = false;
  fireEvent.click(view.getByRole("button", { name: "Hide starter tasks" }));
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull(),
  );
});

for (const index of [1, 3, 4]) {
  test(`unavailable capability for task ${index} shows setup without sending a message`, async () => {
    server({}, false);
    const sent: string[] = [];
    const view = draw({
      agentId: "picked-harness",
      onSelect: (message) => {
        sent.push(message);
      },
    });
    const button = await view.findByRole("button", {
      name: STARTER_SUGGESTIONS[index].title,
    });
    await waitFor(() =>
      expect(view.client.getQueryData(["setup", "checklist"])).toBeTruthy(),
    );
    fireEvent.click(button);
    expect(
      (await view.findByRole("link", { name: "Check setup" })).getAttribute(
        "href",
      ),
    ).toBe("/settings/setup");
    expect(sent).toEqual([]);
  });
}

for (const index of [3, 4]) {
  test(`browser task ${index} can start a configured computer that has never run`, async () => {
    server();
    const sent: string[] = [];
    const view = draw({
      agentId: "personal-assistant",
      onSelect: (message) => {
        sent.push(message);
      },
    });
    const button = await view.findByRole("button", {
      name: STARTER_SUGGESTIONS[index].title,
    });
    await waitFor(() =>
      expect(view.client.getQueryData(["setup", "checklist"])).toBeTruthy(),
    );
    await act(async () => {
      view.client.setQueryData(["setup", "checklist"], {
        audience: "admin",
        rows: [{ id: "computer", status: "not_checked", ready: false }],
      });
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(sent).toEqual([STARTER_SUGGESTIONS[index].message]),
    );
    expect(view.queryByRole("alert")).toBeNull();
  });
}
