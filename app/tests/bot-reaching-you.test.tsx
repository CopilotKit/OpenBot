import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReachingYou } from "@/components/delivery/reaching-you";
import { answerBotsList } from "./bots-api";
import { CONVERSATIONS_PATH, conversationPage } from "./conversations-api";
import {
  CONFIRM_PHONE_PATH,
  LINK_CHAT_PATH,
  notificationsResponse,
  VERIFY_PHONE_PATH,
} from "./notifications-api";
import { settleReactWork } from "./settle-react-work";

/** A Bot's Reaching you page: where this Bot's conversations continue outside OpenBot. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const channel = (id: string, name: string, agentIds: string[]) => ({
  id,
  name,
  agentIds,
  active: true,
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-09T10:00:00Z",
  pinned: false,
  lastReadAt: null,
});

const binding = (id: string, agentId: string, address: string) => ({
  id,
  transport: "slack" as const,
  channelId: `channel-${agentId}`,
  agentId,
  address,
  enabled: true,
});

const writes: { request: string; body: unknown }[] = [];
function serving(sms = false) {
  writes.length = 0;
  const today = {
    bindings: [
      binding("b1", "expenses", "finance-bot-dm"),
      binding("b2", "knowledge", "docs-bot-dm"),
    ],
    available: { slack: true, teams: false, sms, push: false },
  };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ request: `${method} ${url}`, body });
    if (method === "POST" && url === LINK_CHAT_PATH)
      return Response.json({
        platform: "slack",
        code: "abc",
        command: "link abc",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    if (method === "POST" && url === VERIFY_PHONE_PATH)
      return Response.json({
        verificationId: "challenge-1",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    const answered = notificationsResponse(method, url, today, body);
    if (answered) return answered;
    if (url.split("?")[0] === CONVERSATIONS_PATH) {
      return Response.json(
        conversationPage([
          channel("channel-expenses", "Finance desk", ["expenses"]),
          channel("channel-knowledge", "Docs desk", ["knowledge"]),
        ]),
      );
    }
    return (
      answerBotsList(input, init, {
        visible: [
          { id: "expenses", name: "Expenses" },
          { id: "knowledge", name: "Knowledge" },
        ],
      }) ?? Response.json({})
    );
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReachingYou agentId="expenses" />
    </QueryClientProvider>,
  );
}

test("only this Bot's destinations are listed", async () => {
  serving();
  const view = draw();
  expect(await view.findByText(/^Slack/)).toBeTruthy();
  expect(view.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
});

/** The link flow is a dialog: open it from its row, then choose the conversation it continues. */
async function openSlackLink(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document });
  await view.findByRole("button", { name: "Disconnect" });
  await user.click(view.getByRole("button", { name: /^Link Slack/ }));
  return user;
}

async function chooseConversation(
  view: ReturnType<typeof draw>,
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(view.getByRole("combobox", { name: /^Conversation/ }));
  await user.click(await view.findByRole("option", { name }));
}

test("linking Slack needs only a conversation, and warns that it moves the account", async () => {
  serving();
  const view = draw();
  const user = await openSlackLink(view);
  expect(view.queryByRole("combobox", { name: /^Bot/ })).toBeNull();
  expect(view.getByText(/Linking it here moves it/)).toBeTruthy();
  await user.click(view.getByRole("combobox", { name: /^Conversation/ }));
  const options = (await view.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  expect(options).toContain("Finance desk");
  expect(options).not.toContain("Docs desk");
  await user.click(view.getByRole("option", { name: "Finance desk" }));
  await user.click(view.getByRole("button", { name: "Link Slack" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: `POST ${LINK_CHAT_PATH}`,
      body: {
        platform: "slack",
        conversationId: "channel-expenses",
        botId: "expenses",
      },
    }),
  );
  expect(await view.findByText("link abc")).toBeTruthy();
});

test("closing the dialog keeps the link code, so reopening the row shows it again", async () => {
  serving();
  const view = draw();
  const user = await openSlackLink(view);
  await chooseConversation(view, user, "Finance desk");
  await user.click(view.getByRole("button", { name: "Link Slack" }));
  expect(await view.findByText("link abc")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  // The row says a code is waiting, and opening it shows that code without asking for another.
  expect(view.getByText(/Your link code is ready to send/)).toBeTruthy();
  await user.click(view.getByRole("button", { name: /^Link Slack/ }));
  expect(await view.findByText("link abc")).toBeTruthy();
  // With the conversation it links, so "this conversation" still names one.
  expect(
    view.getByRole("combobox", { name: /^Conversation/ }).textContent,
  ).toContain("Finance desk");
  expect(
    writes.filter((write) => write.request === `POST ${LINK_CHAT_PATH}`),
  ).toHaveLength(1);
});

test("nothing can be linked until a conversation is chosen", async () => {
  serving();
  const view = draw();
  const user = await openSlackLink(view);
  expect(
    view.getByRole("button", { name: "Link Slack" }).hasAttribute("disabled"),
  ).toBe(true);
  await chooseConversation(view, user, "Finance desk");
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Link Slack" }).hasAttribute("disabled"),
    ).toBe(false),
  );
});

test("a transport the deployment cannot reach says why instead of opening", async () => {
  serving();
  const view = draw();
  await view.findByRole("button", { name: "Disconnect" });
  expect(
    view.queryByRole("button", { name: /^Link Microsoft Teams/ }),
  ).toBeNull();
  expect(
    view.getByText(
      "Not set up yet. An admin has to turn on Slack and Teams first.",
    ),
  ).toBeTruthy();
});

test("a phone is verified for the chosen conversation, then asks for its code", async () => {
  serving(true);
  sessionStorage.clear();
  const view = draw();
  const user = userEvent.setup({ document });
  await view.findByRole("button", { name: "Disconnect" });
  await user.click(view.getByRole("button", { name: /^Connect a phone/ }));
  await chooseConversation(view, user, "Finance desk");
  await user.type(view.getByLabelText("Phone number"), "+15551234567");
  await user.click(
    view.getByRole("button", { name: "Send verification code" }),
  );
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: `POST ${VERIFY_PHONE_PATH}`,
      body: {
        phone: "+15551234567",
        conversationId: "channel-expenses",
        botId: "expenses",
      },
    }),
  );
  await user.type(await view.findByLabelText("Verification code"), "123456");
  await user.click(view.getByRole("button", { name: "Confirm phone" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: `POST ${CONFIRM_PHONE_PATH}`,
      body: { verificationId: "challenge-1", code: "123456" },
    }),
  );
});
