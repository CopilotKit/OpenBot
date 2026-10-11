import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReachingYou } from "@/components/delivery/reaching-you";
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
  transport: "slack",
  channelId: `channel-${agentId}`,
  agentId,
  address,
  enabled: true,
});

const writes: { request: string; body: unknown }[] = [];
function serving(sms = false) {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        request: `${method} ${url}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({
        platform: "slack",
        code: "abc",
        command: "link abc",
        expiresInMinutes: 10,
        challengeId: "challenge-1",
      });
    }
    if (url.startsWith("/api/delivery")) {
      return Response.json({
        bindings: [
          binding("b1", "expenses", "finance-bot-dm"),
          binding("b2", "knowledge", "docs-bot-dm"),
        ],
        devices: [],
        deliveries: [],
        available: { slack: true, teams: false, sms, push: false },
      });
    }
    if (url.startsWith("/api/channels")) {
      return Response.json({
        channels: [
          channel("channel-expenses", "Finance desk", ["expenses"]),
          channel("channel-knowledge", "Docs desk", ["knowledge"]),
        ],
        nextCursor: null,
      });
    }
    return Response.json({
      agents: [
        { id: "expenses", name: "Expenses" },
        { id: "knowledge", name: "Knowledge" },
      ],
    });
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
      request: "POST /api/delivery/opentag/start",
      body: {
        channelId: "channel-expenses",
        agentId: "expenses",
        platform: "slack",
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
  expect(view.getByText(/A link code is waiting/)).toBeTruthy();
  await user.click(view.getByRole("button", { name: /^Link Slack/ }));
  expect(await view.findByText("link abc")).toBeTruthy();
  // With the conversation it links, so "this conversation" still names one.
  expect(
    view.getByRole("combobox", { name: /^Conversation/ }).textContent,
  ).toContain("Finance desk");
  expect(
    writes.filter(
      (write) => write.request === "POST /api/delivery/opentag/start",
    ),
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
  expect(view.getByText(/needs to pair OpenBot with OpenTag/)).toBeTruthy();
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
      request: "POST /api/delivery/sms/start",
      body: {
        channelId: "channel-expenses",
        agentId: "expenses",
        phone: "+15551234567",
      },
    }),
  );
  await user.type(await view.findByLabelText("Verification code"), "123456");
  await user.click(view.getByRole("button", { name: "Confirm phone" }));
  await waitFor(() =>
    expect(writes).toContainEqual({
      request: "POST /api/delivery/sms/confirm",
      body: { challengeId: "challenge-1", code: "123456" },
    }),
  );
});
