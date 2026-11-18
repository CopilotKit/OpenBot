import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GroupChat } from "@/components/channels/group-chat";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { answerGroupRead, type GroupFixture } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's reply in a group that waits for, or was refused, its person's permission to share it, as
 * that person reads it and as everyone else in the group reads it.
 *
 * Two things were wrong. Everyone read the waiting line with "Open General Assistant" after it, a
 * link to the Bot's page where only the person whose turn it was has anything to answer. And a
 * reply its person chose not to share was drawn red, as an alert, for everyone: a choice drawn as a
 * failure. The waiting line now carries the link for that person only, and a declined reply is the
 * same muted notice as the group's other informational lines.
 *
 * The reads are answered at the HTTP boundary as the server answers them, with the words it writes
 * for each reader; everything above is the real GroupChat.
 */

const CHANNEL = "channel_5b7e3c1a-2f44-4d0e-9a51-6c0f2d8e7b19";
const ASSISTANT = "general-assistant";
const ASKED = "What did I tell you about the Q3 budget?";

const PRIYA = {
  userId: "n4Qk2c8YlZpS0mWfVb1eTj7RuH3xAoGd",
  email: "priya@example.test",
  name: "Priya Shah",
  creator: true,
};
const MARCUS = {
  userId: "Lr9Xh2mVq0cT5sNwJ8bYpE1kUa6dFzGi",
  email: "marcus@example.test",
  name: "Marcus Bell",
  creator: false,
};

const WAITING_FOR_PRIYA =
  "Waiting for permission to share private information with this group conversation. Nothing was sent.";
const WAITING_FOR_MARCUS =
  "Waiting for Priya Shah to allow sharing this reply.";
const DECLINED_FOR_PRIYA =
  "You declined sharing this with them. It was not sent.";
const DECLINED_FOR_MARCUS =
  "Priya Shah didn't share this reply. Nothing was sent.";

let reader = PRIYA;
let group: GroupFixture;

/** Priya asked; her Bot's reply is the line under test. */
function groupWith(reply: GroupFixture["messages"][number]): GroupFixture {
  return {
    bots: [{ id: ASSISTANT, name: "General Assistant" }],
    people: [PRIYA, MARCUS],
    messages: [
      {
        id: "m-1",
        ownerUserId: PRIYA.userId,
        agentId: null,
        text: ASKED,
        status: "completed",
        createdAt: "2026-11-18T10:00:00.000Z",
      },
      reply,
    ],
  };
}

function waiting(reason: string) {
  return groupWith({
    id: `m-1:${ASSISTANT}`,
    ownerUserId: PRIYA.userId,
    agentId: ASSISTANT,
    text: "",
    status: "waiting",
    createdAt: "2026-11-18T10:00:05.000Z",
    reason,
  });
}

function declined(text: string) {
  return groupWith({
    id: `m-1:${ASSISTANT}`,
    ownerUserId: PRIYA.userId,
    agentId: ASSISTANT,
    text,
    status: "failed",
    createdAt: "2026-11-18T10:00:05.000Z",
    declined: true,
  });
}

let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    if (url.pathname === ME_PATH)
      return meResponse({
        user: { id: reader.userId, role: "user", email: reader.email },
      });
    const bots = answerBotsList(url, init, {
      visible: [
        { id: ASSISTANT, name: "General Assistant", avatarSeed: ASSISTANT },
      ],
    });
    if (bots) return bots;
    const read = answerGroupRead(url, init, CHANNEL, group);
    if (read) return read;
    const approvals = approvalInboxResponse(url.pathname, {
      enabled: true,
      requests: [],
      rules: [],
      teamRules: [],
      questions: [],
    });
    if (approvals) return approvals;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
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

/** The group as `who` opens it, once the Bot's line is drawn. */
async function open(who: typeof PRIYA, line: string) {
  reader = who;
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <GroupChat channelId={CHANNEL} />,
    }),
    history: createMemoryHistory({ initialEntries: [`/group/${CHANNEL}`] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(view.queryByText(line, { exact: false })).not.toBeNull(),
  );
  const notice = view.getByText(line, { exact: false });
  return { view, notice };
}

test("the person whose turn it was reads why the reply waits, with the way to answer it", async () => {
  group = waiting(WAITING_FOR_PRIYA);
  const { view, notice } = await open(PRIYA, WAITING_FOR_PRIYA);
  expect(notice.getAttribute("role")).toBe("status");
  const link = view.getByRole("link", { name: "Open General Assistant" });
  expect(link.getAttribute("href")).toBe(`/bots/${ASSISTANT}`);
});

test("everyone else reads who the reply waits for, and is given nothing they can't do", async () => {
  group = waiting(WAITING_FOR_MARCUS);
  const { view, notice } = await open(MARCUS, WAITING_FOR_MARCUS);
  expect(notice.textContent).toBe(WAITING_FOR_MARCUS);
  expect(notice.getAttribute("role")).toBe("status");
  expect(view.queryByRole("link")).toBeNull();
  expect(
    view.queryByText("Open General Assistant", { exact: false }),
  ).toBeNull();
});

test("a reply its person declined to share is a muted notice for that person, not an error", async () => {
  group = declined(DECLINED_FOR_PRIYA);
  const { view, notice } = await open(PRIYA, DECLINED_FOR_PRIYA);
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.className).toContain("text-muted-foreground");
  expect(notice.className).not.toContain("text-destructive");
  expect(view.queryByRole("alert")).toBeNull();
});

test("a reply its person declined to share is a muted notice for everyone else too", async () => {
  group = declined(DECLINED_FOR_MARCUS);
  const { view, notice } = await open(MARCUS, DECLINED_FOR_MARCUS);
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.className).toContain("text-muted-foreground");
  expect(notice.className).not.toContain("text-destructive");
  expect(view.queryByRole("alert")).toBeNull();
});

test("a reply that failed for another reason is still drawn as an error", async () => {
  group = groupWith({
    id: `m-1:${ASSISTANT}`,
    ownerUserId: PRIYA.userId,
    agentId: ASSISTANT,
    text: "The model provider didn't answer.",
    status: "failed",
    createdAt: "2026-11-18T10:00:05.000Z",
  });
  const { notice } = await open(MARCUS, "The model provider didn't answer.");
  expect(notice.getAttribute("role")).toBe("alert");
  expect(notice.className).toContain("text-destructive");
});
