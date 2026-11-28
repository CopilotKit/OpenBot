import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GroupChat } from "@/components/channels/group-chat";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotsList } from "./bots-api";
import { answerGroupRead, type GroupFixture } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Who said a person's line in a conversation with several Bots, as another person in it reads it.
 *
 * Marcus opened a group Priya had asked a Bot in, and her message was headed "Someone else". The
 * conversation's members already name everybody in it (`GET /conversations/{id}/members`, kind
 * `person`, with `name` and `email`), and each line names its sender by `personId`, but the group
 * drew only "You" or "Someone else". A line now carries its sender's name from the members list:
 * their name, their email when they have none, and "Someone who left" for a person no longer in
 * the conversation, whose name is no longer the reader's to see.
 *
 * The transcript is the real run's (bundle r2, group check, read as Marcus). The two reads are
 * answered at the HTTP boundary as the server answers them; everything above is the real GroupChat.
 */

const CHANNEL = "channel_97ea1195-9e93-48e7-8508-855f909dd76f";
const ASSISTANT = "general-assistant";
const KNOWLEDGE = "knowledge";
const ASKED =
  "On your computer, write a small CSV file named group-budget.csv with a header row (item,owner,amount) and three made-up budget lines, then send that file to me in this chat so I can download it. Don't paste its contents, send the file.";

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

function groupWith(
  people: GroupFixture["people"],
  extra: GroupFixture["messages"] = [],
): GroupFixture {
  return {
    bots: [
      { id: ASSISTANT, name: "General Assistant" },
      { id: KNOWLEDGE, name: "Knowledge" },
    ],
    people,
    messages: [
      {
        id: "m-1",
        ownerUserId: PRIYA.userId,
        agentId: null,
        text: ASKED,
        status: "completed",
        createdAt: "2026-11-17T22:30:30.000Z",
      },
      {
        id: `m-1:${ASSISTANT}`,
        ownerUserId: PRIYA.userId,
        agentId: ASSISTANT,
        text: "I’ll create the CSV on my computer and send it here.",
        status: "completed",
        createdAt: "2026-11-17T22:30:50.000Z",
      },
      ...extra,
    ],
  };
}

let group = groupWith([PRIYA, MARCUS]);
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
    // Marcus is the one reading.
    if (url.pathname === ME_PATH)
      return meResponse({
        user: { id: MARCUS.userId, role: "user", email: MARCUS.email },
      });
    const bots = answerBotsList(url, init, {
      visible: [
        { id: ASSISTANT, name: "General Assistant", avatarSeed: ASSISTANT },
        { id: KNOWLEDGE, name: "Knowledge", avatarSeed: KNOWLEDGE },
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

/** The heading over each person's line that is not the reader's own, in transcript order. */
async function senders() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <GroupChat channelId={CHANNEL} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.queryByText(ASKED)).not.toBeNull());
  return [
    ...view.container.querySelectorAll('[data-slot="message-header"]'),
  ].map((header) => header.textContent);
}

test("another person in the group sees a person's message under that person's name", async () => {
  group = groupWith([PRIYA, MARCUS]);
  const headings = await senders();
  expect(headings[0]).toBe("Priya Shah");
  expect(headings).not.toContain("Someone else");
  // The Bot's reply keeps its own name.
  expect(headings[1]).toBe("General Assistant");
});

test("a person with no name is shown by their email, and the reader's own lines carry no heading", async () => {
  group = groupWith(
    [{ ...PRIYA, name: null }, MARCUS],
    [
      {
        id: "m-2",
        ownerUserId: MARCUS.userId,
        agentId: null,
        text: "Thanks, got it.",
        status: "completed",
        createdAt: "2026-11-17T22:31:10.000Z",
      },
    ],
  );
  const headings = await senders();
  expect(headings).toEqual(["priya@example.test", "General Assistant"]);
});

test("a person who has left the group is not named", async () => {
  group = groupWith([MARCUS]);
  const headings = await senders();
  expect(headings[0]).toBe("Someone who left");
  expect(headings.join(" ")).not.toContain("Priya");
});

/*
 * A person who deleted their account: what they said stays for the others with no sender (the
 * server sets it to null), and reads "Deleted user", as GitHub's ghost does. Never "Someone who
 * left", which is somebody still about who left the conversation.
 */
test("a line whose sender deleted their account reads Deleted user", async () => {
  const left = groupWith([MARCUS]);
  group = {
    ...left,
    messages: left.messages.map((message) => ({ ...message, ownerUserId: "" })),
  };
  const headings = await senders();
  expect(headings[0]).toBe("Deleted user");
  expect(headings).not.toContain("Someone who left");
});
