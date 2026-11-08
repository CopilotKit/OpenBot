import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { STARTER_SUGGESTIONS } from "@/components/starter-tour/suggestions";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { settleReactWork } from "./settle-react-work";

/** Real home/new routes hand the selected starter prompt to real ChannelChat and its HTTP run. */
const NativeResponse = globalThis.Response;
const BOT = "picked-harness";

const bot: AgentProfile = {
  avatarSeed: "seed",
  builtIn: true,
  canManage: true,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  mine: true,
  name: "My renamed colleague",
  roleDescription: "Counts things.",
  systemOwned: false,
  title: "Clerk",
  visibility: "private",
  id: BOT,
  runsOnOpenBotModel: true,
};

const channel: AgentChannel = {
  id: "new-skill-channel",
  name: "My renamed colleague",
  agentIds: [BOT],
  threadId: "new-skill-thread",
  active: true,
  lastMessageAt: "2026-11-05T00:00:00.000Z",
};

/** The run inputs that actually left the browser, in order. */
let runs: RunAgentInput[] = [];
let runPaths: string[] = [];
let creates: { agentIds: string[] }[] = [];
let chosen: { agentId?: string; text?: string }[] = [];
let preferences: { starterTourChannelId?: string } = {};
let failModel = false;
let modelSaveGate: Promise<void> | undefined;
let failRun = false;
let runModels: (string | null)[] = [];
let deletes = 0;
let saved = { model: null as string | null, effort: null as string | null };

let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  /*
   * The `/` menu opens at the caret: prompt-area measures the caret's range and draws no menu for
   * a range with no box. happy-dom lays nothing out, so every range measures empty; a browser's
   * caret is a line tall. This is that line, and nothing else about layout is assumed.
   */
  const caret = { x: 8, y: 8, top: 8, left: 8, width: 1, height: 16 };
  Range.prototype.getBoundingClientRect = () =>
    ({ ...caret, right: 9, bottom: 24, toJSON: () => caret }) as DOMRect;
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname === "/api/me")
        return NativeResponse.json({
          user: {
            id: "person",
            name: "Sam",
            email: "sam@example.com",
            role: "admin",
            onboarding: null,
          },
        });
      if (url.pathname === "/api/settings/preferences")
        return NativeResponse.json({ preferences });
      if (url.pathname === "/api/capabilities")
        return NativeResponse.json({ generativeUi: true });
      if (url.pathname === "/api/setup")
        return NativeResponse.json({
          checklist: {
            audience: "admin",
            rows: [{ id: "computer", ready: true }],
          },
        });
      if (url.pathname === "/api/channels" && method === "GET")
        return NativeResponse.json({ channels: [], nextCursor: null });
      if (url.pathname === "/api/channels" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        creates.push(body);
        channel.id = `tour-channel-${creates.length}`;
        channel.threadId = `tour-thread-${creates.length}`;
        channel.agentIds = body.agentIds;
        preferences.starterTourChannelId ??= channel.id;
        return NativeResponse.json({ channel }, { status: 201 });
      }
      if (url.pathname === "/api/route") {
        chosen.push(JSON.parse(String(init?.body)));
        // The response cannot override the explicitly selected starter recipient.
        return NativeResponse.json({
          agentId: "other-bot",
          reason: "fixture override",
        });
      }
      if (url.pathname === "/api/models")
        return NativeResponse.json({
          provider: "openai",
          source: "openai",
          exposure: "all",
          default: "default-model",
          choosable: true,
          models: [
            { id: "default-model", label: "Default model", vendor: "openai" },
            {
              id: "alternate-model",
              label: "Alternate model",
              vendor: "openai",
            },
          ],
        });
      if (url.pathname.endsWith("/model")) {
        if (method === "PUT") {
          await modelSaveGate;
          if (failModel)
            return NativeResponse.json(
              { error: "Model save failed. Try again." },
              { status: 500 },
            );
          saved = JSON.parse(String(init?.body));
        }
        return NativeResponse.json(saved);
      }
      if (
        url.pathname === `/api/channels/${channel.id}` &&
        method === "DELETE"
      ) {
        deletes++;
        if (
          url.searchParams.get("discardFailedStart") === "true" &&
          preferences.starterTourChannelId === channel.id
        )
          preferences = {};
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [bot] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({ agent: bot });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({
          tools: [],
          skills: [],
        });
      if (url.pathname === `/api/components/for-agent/${BOT}`)
        return NativeResponse.json({ components: [] });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (url.pathname === "/api/admin/enterprise/me")
        return NativeResponse.json({ capabilities: {}, enforced: false });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        runPaths.push(url.pathname);
        runModels.push(saved.model);
        if (failRun)
          return sse([
            { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
            {
              type: "RUN_ERROR",
              message: "Starter task failed once",
              code: "agent_error",
            },
          ]);
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (/\/api\/channels\/[^/]+(\/(activity|busy|read))?$/.test(url.pathname))
        return method === "GET"
          ? NativeResponse.json({ channel })
          : new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+(\/messages)?$/.test(url.pathname))
        return NativeResponse.json({ messages: [] });
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  runs = [];
  runPaths = [];
  creates = [];
  chosen = [];
  preferences = {};
  failModel = false;
  modelSaveGate = undefined;
  failRun = false;
  runModels = [];
  deletes = 0;
  saved = { model: null, effort: null };
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);

/** The channel screen, as far as sending goes: the channel record and `ChannelChat` on it. */
function ChannelScreen() {
  const { channelId } = channelRoute.useParams();
  const { data } = useQuery(channelQueryOptions(channelId));
  return data ? (
    <ChannelChat channel={data} runtimeAgentId={data.agentIds[0]!} />
  ) : null;
}
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: ChannelScreen,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([
      testChannelNewRoute,
      channelRoute,
      createRoute({
        path: "/",
        getParentRoute: () => appRoute,
        component: HomeRoute.options.component,
      }),
    ]),
  ]),
]);

function draw(path: string) {
  queryClient.setQueryData(agentKeys.list(false), [bot]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <RouterProvider router={router} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

for (const path of ["/", `/channel/new?agent=${BOT}`]) {
  test(`${path}: first and second starter choices run on the selected Bot in the same channel`, async () => {
    const view = draw(path);
    fireEvent.click(
      await view.findByRole("button", { name: STARTER_SUGGESTIONS[0].title }),
    );
    await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
    expect(creates).toEqual([{ agentIds: [BOT] }]);
    expect(chosen[0]?.agentId).toBe(BOT);
    expect(
      runs[0]?.messages.find((message) => message.role === "user")?.content,
    ).toBe(STARTER_SUGGESTIONS[0].message);
    expect(runPaths[0]).toContain(BOT);
    expect(runs[0]?.threadId).toBe("tour-thread-1");
    await waitFor(() =>
      expect(
        (
          view.getByRole("button", {
            name: STARTER_SUGGESTIONS[2].title,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      view.getByRole("button", { name: STARTER_SUGGESTIONS[2].title }),
    );
    await waitFor(() => expect(runs).toHaveLength(2), { timeout: 5000 });
    expect(
      runs[1]?.messages.filter((message) => message.role === "user").at(-1)
        ?.content,
    ).toBe(STARTER_SUGGESTIONS[2].message);
    expect(runs[1]?.threadId).toBe(runs[0]?.threadId);
    expect(runPaths[1]).toBe(runPaths[0]);
    expect(creates).toHaveLength(1);
    await act(async () => {
      await view.router.navigate({
        to: "/channel/new",
        search: { agent: BOT },
      });
    });
    await view.findByRole("textbox", { name: "Message" });
    expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull();
    const user = userEvent.setup({ document });
    await user.type(
      view.getByRole("textbox", { name: "Message" }),
      "An ordinary later conversation.{Enter}",
    );
    await waitFor(() => expect(runs).toHaveLength(3), { timeout: 5000 });
    expect(creates).toHaveLength(2);
    expect(runs[2]?.threadId).toBe("tour-thread-2");
    expect(view.queryByRole("region", { name: "Starter tasks" })).toBeNull();
  });
}

test("new conversation model save failure discards the claim and lets the starter task retry", async () => {
  const view = draw(`/channel/new?agent=${BOT}`);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("combobox", { name: /Model: Default model/ }),
  );
  await user.click(
    within(await view.findByRole("dialog")).getByRole("option", {
      name: "Alternate model",
    }),
  );
  failModel = true;
  fireEvent.click(
    await view.findByRole("button", { name: STARTER_SUGGESTIONS[0].title }),
  );
  await waitFor(() => expect(deletes).toBe(1));
  expect(runs).toHaveLength(0);
  await view.findByText("Model save failed. Try again.");
  const retry = await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[0].title,
  });
  failModel = false;
  fireEvent.click(retry);
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
  expect(creates).toHaveLength(2);
  expect(preferences.starterTourChannelId).toBe("tour-channel-2");
  expect(
    runs[0]?.messages.find((message) => message.role === "user")?.content,
  ).toBe(STARTER_SUGGESTIONS[0].message);
});

for (const failed of [false, true]) {
  test(`in-conversation suggestions wait for model saving (failure: ${failed})`, async () => {
    const view = draw("/");
    fireEvent.click(
      await view.findByRole("button", { name: STARTER_SUGGESTIONS[0].title }),
    );
    await waitFor(() => expect(runs).toHaveLength(1));
    const suggestion = (await view.findByRole("button", {
      name: STARTER_SUGGESTIONS[2].title,
    })) as HTMLButtonElement;
    await waitFor(() => expect(suggestion.disabled).toBe(false));
    let release = () => {};
    modelSaveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    failModel = failed;
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("combobox", { name: /Model: Default model/ }),
    );
    await user.click(
      within(await view.findByRole("dialog")).getByRole("option", {
        name: "Alternate model",
      }),
    );
    await waitFor(() => expect(suggestion.disabled).toBe(true));
    fireEvent.click(suggestion);
    expect(runs).toHaveLength(1);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(suggestion.disabled).toBe(false));
    expect(runs).toHaveLength(1);
    if (!failed) {
      fireEvent.click(suggestion);
      await waitFor(() => expect(runs).toHaveLength(2));
      expect(runModels[1]).toBe("alternate-model");
    } else {
      expect(saved.model).toBeNull();
    }
  });
}

test("a failed in-conversation starter turn reports its error only in the transcript", async () => {
  const view = draw("/");
  fireEvent.click(
    await view.findByRole("button", { name: STARTER_SUGGESTIONS[0].title }),
  );
  await waitFor(() => expect(runs).toHaveLength(1));
  const suggestion = (await view.findByRole("button", {
    name: STARTER_SUGGESTIONS[2].title,
  })) as HTMLButtonElement;
  await waitFor(() => expect(suggestion.disabled).toBe(false));
  failRun = true;
  fireEvent.click(suggestion);
  await view.findByText("Starter task failed once");
  await waitFor(() => expect(suggestion.disabled).toBe(false));
  expect(view.getAllByText("Starter task failed once")).toHaveLength(1);
  expect(
    within(view.getByRole("region", { name: "Starter tasks" })).queryByRole(
      "alert",
    ),
  ).toBeNull();
});
