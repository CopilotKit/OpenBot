import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import { forgetSendingHere } from "@/components/channels/composer/kept-first-message";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { type AgentChannel, channelQueryOptions } from "@/lib/channels/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { MY_CAPABILITIES_PATH } from "./admin-settings-api";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import { botComponentsPath, botComponentsResponse } from "./components-api";
import {
  CONVERSATIONS_PATH,
  conversationOf,
  conversationPath,
  ROUTE_PATH,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A NEW CONVERSATION'S FIRST MESSAGE IS NEVER LOST, AND NEVER SENT TWICE.
 *
 * Its conversation opens with the message showing, and the page sends it a moment later. A page
 * that died in that moment (a phone locked, a tab closed or reloaded) used to leave the conversation
 * empty and the words gone. Now the words are kept from the moment the conversation exists until the
 * server has started the run that answers them, and the conversation opened again puts them back in
 * its message box, unsent. Sending them from there runs one turn, and nothing is sent on its own.
 *
 * "The server has it" is its run starting (RUN_STARTED). Here the server either starts the run, or
 * never answers, as one the page died before reaching. Everything below the HTTP boundary is real,
 * as in `new-conversation-sends-at-once.test.tsx`; a page dying is everything it held in memory
 * going (`diePage`), with what it kept in the browser's storage left.
 */

const NativeResponse = globalThis.Response;
const BOT = "harbour-bot";
const QUESTION = "When is high water at the north quay?";

const bot: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
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
  name: "Harbour Bot",
  roleDescription: "Knows the tides.",
  systemOwned: false,
  title: "Harbour master",
  visibility: "private",
  id: BOT,
};

const channel: AgentChannel = {
  id: "kept-first-channel",
  name: "Harbour Bot",
  agentIds: [BOT],
  threadId: "kept-first-thread",
  active: true,
  lastMessageAt: null,
};

/** Whether the server starts the runs it is sent, or never answers them. */
let serverAnswers = true;
/** Whether the server makes the conversations it is asked for, or never answers. */
let makes = true;
/**
 * Whether a run the server takes has its start reach the page. False is the server taking the
 * message and answering it while the page dies before it hears so.
 */
let startReaches = true;
/** What the server holds of the conversation's thread, as its history read answers it. */
let stored: unknown[] = [];
/** The run inputs that reached the server, in order. */
let runs: RunAgentInput[] = [];
/** Runs the server never answered, which a dying page drops. */
const unanswered: ((error: Error) => void)[] = [];
let originalFetch: typeof fetch;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function signIn() {
  setCurrentOrganization("default");
  queryClient.setQueryDefaults(authKeys.currentUser(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "dana",
    name: "Dana Reyes",
    email: "dana.reyes@harbour.example",
  } as AuthenticatedUser);
  queryClient.setQueryData(agentKeys.list(false), [bot]);
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
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
      // Never answered: a page that dies waiting on it runs nothing after, as a closed tab doesn't.
      if (url.pathname === CONVERSATIONS_PATH && method === "POST" && !makes)
        return new Promise<Response>(() => {});
      if (url.pathname === CONVERSATIONS_PATH && method === "POST")
        return NativeResponse.json(
          { conversation: conversationOf(channel) },
          { status: 201 },
        );
      if (url.pathname === ROUTE_PATH)
        return NativeResponse.json({
          botId: BOT,
          name: bot.name,
          reason: "chosen",
          fallback: false,
          viaMention: false,
        });
      const bots = answerBotsList(url, init, { visible: [bot] });
      if (bots) return bots;
      if (url.pathname === botPath(BOT))
        return NativeResponse.json({ bot: bot });
      if (url.pathname === botGrantsPath(BOT))
        return botGrantsResponse({ tools: [], skills: [] });
      if (url.pathname === botComponentsPath(BOT))
        return botComponentsResponse();
      if (url.pathname === MY_CAPABILITIES_PATH)
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
        if (!serverAnswers)
          return new Promise<Response>((_resolve, reject) => {
            unanswered.push(reject);
          });
        runs.push(body);
        if (!startReaches) {
          // Taken and answered on the server; the page never hears the run start.
          stored = [
            ...body.messages,
            {
              id: "answer-1",
              role: "assistant",
              content: "High water is at noon.",
            },
          ];
          return new Promise<Response>((_resolve, reject) => {
            unanswered.push(reject);
          });
        }
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/voice-sessions$/.test(
          url.pathname,
        )
      )
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (url.pathname === conversationPath(channel.id) && method === "GET")
        return NativeResponse.json({ conversation: conversationOf(channel) });
      if (/\/threads\/[^/]+(\/messages)?$/.test(url.pathname))
        return NativeResponse.json({ messages: stored });
      if (
        /^\/api\/v2\/organizations\/default\/conversations\/[^/]+\/(activity|signal-busy|mark-read)$/.test(
          url.pathname,
        ) &&
        method === "POST"
      )
        return new NativeResponse(null, { status: 204 });
      // Anything else this screen asks for has nothing to say here.
      return new NativeResponse(null, { status: 404 });
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});

afterEach(async () => {
  await diePage();
  window.localStorage.clear();
  serverAnswers = true;
  makes = true;
  startReaches = true;
  stored = [];
  runs = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/**
 * The page dies: what it rendered and held in memory goes, and the requests it had out are
 * dropped. What it kept in the browser's storage stays, as a closed tab leaves it.
 */
async function diePage() {
  for (const drop of unanswered.splice(0))
    drop(new TypeError("Failed to fetch"));
  await settleReactWork();
  cleanup();
  queryClient.clear();
  forgetSendingHere();
}

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
  return data ? <ChannelChat channel={data} runtimeAgentId={BOT} /> : null;
}
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: ChannelScreen,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, channelRoute]),
  ]),
]);

/** A page opened at `path`, signed in. */
function openPage(path: string) {
  signIn();
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
  return { router, view };
}

/** Send `QUESTION` from a new conversation, and wait for it to show in the conversation. */
async function sendFromNewConversation() {
  const { router, view } = openPage(`/channel/new?agent=${BOT}`);
  const user = userEvent.setup({ document });
  const editor = await view.findByRole("textbox", { name: "Message" });
  await waitFor(() =>
    expect(editor.getAttribute("aria-disabled")).not.toBe("true"),
  );
  await user.click(editor);
  await user.keyboard(QUESTION);
  await user.keyboard("{Enter}");
  await waitFor(
    () => expect(router.state.location.pathname).toBe(`/channel/${channel.id}`),
    { timeout: 5000 },
  );
  await view.findByText(QUESTION, { exact: true }, { timeout: 5000 });
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

test("a page that dies before the server has the first message gives the words back, unsent", async () => {
  serverAnswers = false;
  await sendFromNewConversation();
  await diePage();

  // Opened again, as a notification or the sidebar opens it.
  serverAnswers = true;
  const { view } = openPage(`/channel/${channel.id}`);
  // The box opens again with them once the thread is read, so it is found afresh.
  const box = () => view.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(box().textContent).toContain(QUESTION), {
    timeout: 5000,
  });
  // Nothing is sent on its own: the person decides.
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(runs).toHaveLength(0);

  // Sent from the box, it runs once.
  const editor = box();
  const user = userEvent.setup({ document });
  await waitFor(() =>
    expect(editor.getAttribute("aria-disabled")).not.toBe("true"),
  );
  await user.click(editor);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
  const asked = (runs[0]?.messages ?? []).filter(
    (message) => message.role === "user" && textOf(message) === QUESTION,
  );
  expect(asked).toHaveLength(1);
}, 30_000);

test("a page that dies while its Send is still making the conversation gives the words to the next new conversation", async () => {
  makes = false;
  const { view } = openPage(`/channel/new?agent=${BOT}`);
  const user = userEvent.setup({ document });
  const editor = await view.findByRole("textbox", { name: "Message" });
  await waitFor(() =>
    expect(editor.getAttribute("aria-disabled")).not.toBe("true"),
  );
  await user.click(editor);
  await user.keyboard(QUESTION);
  await user.keyboard("{Enter}");
  // The page dies before the conversation is made.
  await settleReactWork();
  await diePage();

  // The next new conversation, a visit of its own.
  makes = true;
  const next = openPage(`/channel/new?agent=${BOT}`);
  const box = await next.view.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(box.textContent).toContain(QUESTION), {
    timeout: 5000,
  });
  expect(runs).toHaveLength(0);
}, 30_000);

test("a first message the server took while its page died, before the page heard so, is not given back", async () => {
  startReaches = false;
  await sendFromNewConversation();
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
  await diePage();

  // Opened again: the message and its answer, and nothing in the box to send twice.
  const { view } = openPage(`/channel/${channel.id}`);
  await view.findByText("High water is at noon.", undefined, { timeout: 5000 });
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const editor = await view.findByRole("textbox", { name: "Message" });
  expect(editor.textContent ?? "").not.toContain(QUESTION);
  expect(runs).toHaveLength(1);
}, 30_000);

test("a first message the server has is not given back", async () => {
  await sendFromNewConversation();
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000 });
  await diePage();

  const { view } = openPage(`/channel/${channel.id}`);
  const editor = await view.findByRole("textbox", { name: "Message" });
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(editor.textContent ?? "").not.toContain(QUESTION);
  expect(runs).toHaveLength(1);
}, 30_000);
