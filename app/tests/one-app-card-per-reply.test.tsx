import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import { approvalInboxResponse } from "./approvals-api";
import { botAppPath, botAppResponse } from "./bot-grants-api";
import { botPath } from "./bots-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * ONE CARD PER APP, IN THE REAL TRANSCRIPT.
 *
 * Reported in dogfooding on 1.2.0-rc.3: a Bot searched its tools, found Google Ads and PostHog, and
 * called two Google Ads tools and one PostHog tool. Neither app was connected, so all three calls
 * were refused, each with its app's card, and the reply showed Google Ads, Google Ads again, then
 * PostHog. The second Google Ads card added nothing and read as a second thing to do.
 *
 * Drawn here as a conversation draws it: the transcript, the live card asking the server for each
 * app's state, and the answers in the API's shapes.
 */

const BOT = "assistant";
const GOOGLE_ADS = "composio-googleads";
const POSTHOG = "composio-posthog";

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/channel/one" });
});
beforeEach(() => {
  queryClient.clear();
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://127.0.0.1:3010",
      ).pathname;
      const approvals = approvalInboxResponse(url, {
        enabled: false,
        requests: [],
        rules: [],
        teamRules: [],
        questions: [],
      });
      if (approvals) return approvals;
      if (url === DEPLOYMENT_PATH) return Response.json({ edition: "team" });
      if (url === ME_PATH)
        return meResponse({
          user: { id: "usr_me", role: "member", name: "Me" },
        });
      if (url === botPath(BOT))
        return Response.json({ bot: { id: BOT, name: "General Assistant" } });
      if (url === botAppPath(BOT, GOOGLE_ADS))
        return botAppResponse(
          appAccess({
            key: GOOGLE_ADS,
            displayName: "Google Ads",
            state: "not_connected",
          }),
        );
      if (url === botAppPath(BOT, POSTHOG))
        return botAppResponse(
          appAccess({
            key: POSTHOG,
            displayName: "PostHog",
            state: "not_connected",
          }),
        );
      if (url.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** The tool result a call to an app the person hasn't connected comes back with. */
function refused(id: string, serverId: string, title: string): Message {
  return {
    id: `t-${id}`,
    role: "tool",
    toolCallId: id,
    content: JSON.stringify(
      `Refused. ${connectAppRefusal({
        serverId,
        title,
        agentId: BOT,
        message: `You have not connected your ${title} account. Connect it and ask again.`,
      })}`,
    ),
  };
}

/** One person's question and the Bot's reply that called Google Ads twice and PostHog once. */
function reply(turn: string): Message[] {
  return [
    { id: `u-${turn}`, role: "user", content: "Find her email." },
    {
      id: `a-${turn}`,
      role: "assistant",
      content: "",
      toolCalls: [
        call(`ads1-${turn}`, "mcp__composio-googleads__GOOGLEADS_SEARCH", {
          query: "her email",
        }),
        call(`ads2-${turn}`, "mcp__composio-googleads__GOOGLEADS_GET_CUSTOMER"),
        call(`ph-${turn}`, "mcp__composio-posthog__POSTHOG_SEARCH_PERSONS", {
          search: "her email",
        }),
      ],
    },
    refused(`ads1-${turn}`, GOOGLE_ADS, "Google Ads"),
    refused(`ads2-${turn}`, GOOGLE_ADS, "Google Ads"),
    refused(`ph-${turn}`, POSTHOG, "PostHog"),
    {
      id: `said-${turn}`,
      role: "assistant",
      content: "Google Ads and PostHog need connecting first.",
    },
  ];
}

function draw(messages: Message[]) {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ChatTranscript busy={false} messages={messages} restoring={false} />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <RouterProvider router={router as never} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const cards = (container: HTMLElement, app: string) =>
  container.querySelectorAll(`[data-app-access="${app}"]`);

test("a reply that calls the same unconnected app twice shows its card once", async () => {
  const view = draw(reply("1"));
  await view.findByText("Google Ads and PostHog need connecting first.");
  await waitFor(() => {
    expect(cards(view.container, POSTHOG)).toHaveLength(1);
    expect(
      cards(view.container, GOOGLE_ADS)[0]?.getAttribute("data-state"),
    ).toBe("not_connected");
  });
  expect(cards(view.container, GOOGLE_ADS)).toHaveLength(1);
  // Still the card, with its button.
  expect(
    await view.findByRole("button", { name: "Connect Google Ads" }),
  ).toBeTruthy();
});

test("asked again in a later reply, the app's card is shown once, under the reply asking now", async () => {
  const view = draw([...reply("1"), ...reply("2")]);
  const answers = await view.findAllByText(
    "Google Ads and PostHog need connecting first.",
  );
  expect(answers).toHaveLength(2);
  await waitFor(() =>
    expect(cards(view.container, GOOGLE_ADS)).toHaveLength(1),
  );
  expect(cards(view.container, POSTHOG)).toHaveLength(1);
  // The one card left sits after the person's second question.
  const [, second] = view.getAllByText("Find her email.");
  const card = cards(view.container, GOOGLE_ADS)[0];
  expect(second && card).toBeTruthy();
  expect(
    (second as Node).compareDocumentPosition(card as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
