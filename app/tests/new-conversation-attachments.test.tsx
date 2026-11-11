import "./home-fallback-routing.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { takeFailedStart } from "@/lib/channels/pending-start";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { settleReactWork } from "./settle-react-work";

/**
 * A FILE ATTACHED BEFORE THE FIRST MESSAGE GOES WITH THAT MESSAGE.
 *
 * `/channel/new` and the home screen create the conversation with the first message, and their
 * composer used to take no files at all: `+` said it had nothing to offer and a drop was refused
 * with "There is no conversation here yet". Now the files are held in the tab, uploaded to the
 * conversation the first message creates, and sent with it, so the Bot reads them on that turn.
 *
 * Everything below the HTTP boundary is real: the routes, the composer, the start sequence, the
 * hand-over to `ChannelChat` and the run request. Only `fetch` is a fixture, answering the upload,
 * withdraw and discard routes as `POST /api/channels/:id/attachments`, `DELETE /api/attachments/:id`
 * and `DELETE /api/channels/:id?discardFailedStart=true` do.
 */

const NativeResponse = globalThis.Response;
const BOT = "terra-bot";
const REFUSED = "blob.bin";
const REFUSAL = `'${REFUSED}' isn't a file type OpenBot can read.`;

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
  name: "Terra Bot",
  roleDescription: "Answers on OpenBot's model.",
  systemOwned: false,
  title: "Analyst",
  visibility: "public",
  id: BOT,
  runsOnOpenBotModel: false,
};

const channel: AgentChannel = {
  id: "attach-channel",
  name: "Terra Bot",
  agentIds: [BOT],
  threadId: "attach-thread",
  active: true,
  lastMessageAt: "2026-11-11T00:00:00.000Z",
};

/** Every request that creates, uploads, withdraws, discards or runs, in the order it left. */
let trail: string[] = [];
/** The user turns each run carried. */
let runs: unknown[] = [];
let uploads = 0;
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  Range.prototype.getBoundingClientRect = () => new DOMRect(8, 8, 1, 16);
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
      if (url.pathname === "/api/channels" && method === "POST") {
        trail.push("create");
        return NativeResponse.json({ channel }, { status: 201 });
      }
      if (url.pathname === `/api/channels/${channel.id}/attachments`) {
        const file = (init?.body as FormData | undefined)?.get("file") as File;
        trail.push(`upload ${file.name}`);
        if (file.name === REFUSED)
          return NativeResponse.json({ error: REFUSAL }, { status: 415 });
        uploads += 1;
        return NativeResponse.json(
          { id: `att-${uploads}`, name: file.name, mimeType: "text/plain" },
          { status: 201 },
        );
      }
      if (url.pathname.startsWith("/api/attachments/") && method === "DELETE") {
        trail.push(`withdraw ${url.pathname.split("/").at(-1)}`);
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname.startsWith("/api/attachments/"))
        return new NativeResponse(null, { status: 200 });
      if (
        url.pathname === `/api/channels/${channel.id}` &&
        method === "DELETE"
      ) {
        trail.push(`discard ${url.searchParams.get("discardFailedStart")}`);
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname === "/api/route")
        return NativeResponse.json({
          agentId: BOT,
          name: bot.name,
          reason: "chosen",
          fallback: false,
          viaMention: false,
        });
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [bot] });
      if (url.pathname === `/api/agents/${BOT}`)
        return NativeResponse.json({ agent: bot });
      if (url.pathname === `/api/plugins/for/${BOT}`)
        return NativeResponse.json({ tools: [], skills: [] });
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
        trail.push("run");
        runs.push(body.messages.filter((message) => message.role === "user"));
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
  takeFailedStart();
  trail = [];
  runs = [];
  uploads = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const rootRoute = createRootRoute({ component: Outlet });
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof rootRoute;
};
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: HomeRoute.options.validateSearch,
  component: HomeRoute.options.component,
});
const startRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/start/$startId",
  component: () => <p>Starting</p>,
});
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => rootRoute,
} as TestFileRouteWiring);

/** The channel screen, as far as sending goes: the channel record and `ChannelChat` on it. */
function ChannelScreen() {
  const { channelId } = channelRoute.useParams();
  const { data } = useQuery(channelQueryOptions(channelId));
  return data ? <ChannelChat channel={data} runtimeAgentId={BOT} /> : null;
}
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => rootRoute,
  component: ChannelScreen,
});
const routeTree = rootRoute.addChildren([
  homeRoute,
  startRoute,
  testChannelNewRoute,
  channelRoute,
]);

function renderAt(entry: string) {
  queryClient.setQueryData(agentKeys.list(false), [bot]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <RouterProvider router={router} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, {
    router,
    user: userEvent.setup({ document }),
  });
}

function notes(name = "notes.txt") {
  return new File(["Secret word: PINEAPPLE"], name, { type: "text/plain" });
}

/** The attachment parts the first run's user turn carried. */
function sentParts() {
  const [turns] = runs as Array<Array<{ content: unknown }>>;
  const content = turns?.at(-1)?.content;
  return Array.isArray(content)
    ? content.filter((part) => (part as { type: string }).type !== "text")
    : [];
}

test("a file attached with + on /channel/new is uploaded to the conversation it creates and sent with the first message", async () => {
  const view = renderAt(`/channel/new?agent=${BOT}`);

  // Before the fix this composer had no `+` to offer and no file input behind it.
  await view.findByRole("button", { name: "Attach a file" });
  const input = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await view.user.upload(input, notes());
  await view.findByLabelText("Remove notes.txt");
  // Held in the tab: nothing is created or uploaded until the message is sent.
  expect(trail).toEqual([]);

  await view.user.click(await view.findByRole("textbox", { name: "Message" }));
  await view.user.keyboard("What is the secret word?{Enter}");

  await waitFor(() => expect(trail).toContain("run"), { timeout: 5000 });
  expect(trail).toEqual(["create", "upload notes.txt", "run"]);
  expect(sentParts()).toEqual([
    {
      type: "document",
      source: { type: "url", value: "/api/attachments/att-1" },
      metadata: { attachmentId: "att-1", filename: "notes.txt" },
    },
  ]);
  // And the conversation draws the file in the message it was sent with.
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[data-slot="message-scroller-viewport"]')
        ?.textContent?.includes("notes.txt"),
    ).toBe(true),
  );
});

test("a file dropped on the home composer goes with the message that starts the conversation", async () => {
  const view = renderAt("/");

  const form = (await view.findByRole("textbox", { name: "Message" })).closest(
    "form",
  ) as HTMLFormElement;
  fireEvent.drop(form, {
    dataTransfer: { files: [notes()], types: ["Files"] },
  });
  await view.findByLabelText("Remove notes.txt");
  expect(trail).toEqual([]);

  await view.user.click(view.getByRole("textbox", { name: "Message" }));
  await view.user.keyboard("Read this{Enter}");

  await waitFor(() => expect(trail).toContain("run"), { timeout: 5000 });
  expect(trail).toEqual(["create", "upload notes.txt", "run"]);
  expect(sentParts()).toEqual([
    {
      type: "document",
      source: { type: "url", value: "/api/attachments/att-1" },
      metadata: { attachmentId: "att-1", filename: "notes.txt" },
    },
  ]);
});

test("a file the server refuses on the first send takes the new conversation back and keeps the draft", async () => {
  const view = renderAt(`/channel/new?agent=${BOT}`);

  // Dropped, since the dialog's `accept` hint would grey this one out: bytes no reader knows,
  // claimed as nothing in particular, which the composer passes for the server to sniff.
  const form = (
    await view.findByRole("button", { name: "Attach a file" })
  ).closest("form") as HTMLFormElement;
  fireEvent.drop(form, {
    dataTransfer: {
      files: [
        notes(),
        new File([new Uint8Array([0, 159, 146, 150])], REFUSED, {
          type: "application/octet-stream",
        }),
      ],
      types: ["Files"],
    },
  });
  await view.findByLabelText(`Remove ${REFUSED}`);

  await view.user.click(view.getByRole("textbox", { name: "Message" }));
  await view.user.keyboard("Summarise both{Enter}");

  // The server's own sentence, in the screen's notice.
  expect((await view.findByRole("alert")).textContent).toBe(REFUSAL);
  // The file that did land is withdrawn before the conversation is discarded, so nothing is left
  // staged against a conversation nobody can see. No run.
  const uploaded = trail.filter((step) => step.startsWith("upload")).sort();
  expect(uploaded).toEqual([`upload ${REFUSED}`, "upload notes.txt"]);
  expect(trail.slice(-2)).toEqual(["withdraw att-1", "discard true"]);
  expect(trail).not.toContain("run");
  // The words and both files are back in the box for another try.
  await view.findByLabelText("Remove notes.txt");
  await view.findByLabelText(`Remove ${REFUSED}`);
  const box = view.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(box.textContent).toBe("Summarise both"));
  expect(view.router.state.location.pathname).toBe("/channel/new");
});

test("attaching a file and leaving creates no conversation and uploads nothing", async () => {
  const view = renderAt(`/channel/new?agent=${BOT}`);

  const input = (await view.findByRole("button", { name: "Attach a file" }))
    .closest("form")
    ?.querySelector('input[type="file"]') as HTMLInputElement;
  await view.user.upload(input, notes());
  const chip = await view.findByLabelText("Remove notes.txt");
  expect(within(chip.closest("form") as HTMLElement).getByText("notes.txt"));

  await view.router.navigate({ to: "/" });
  await view.findByRole("textbox", { name: "Message" });
  await settleReactWork();

  expect(trail).toEqual([]);
});
