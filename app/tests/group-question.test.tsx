import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  splitMessageReplies,
  withMessageReply,
} from "@openbot/shared/message-reply";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { GroupChat } from "@/components/channels/group-chat";
import type { GroupMessage } from "@/lib/groups";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotAttention, answerBotsList, attentionOf } from "./bots-api";
import { answerGroupRead, conversationPath } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's question in a conversation with two Bots.
 *
 * The person asked Errand Helper which area to do first, and it asked them back. The question was
 * saved and the sidebar badge counted it, but the group conversation drew no question, so Answer on
 * the Bots page opened a conversation with nothing in it to answer and the badge could not be
 * cleared. It now waits above the composer, as it does in a conversation with one Bot, and what
 * the person sends answers it.
 *
 * The group, the inbox, the badge and the answer route are played at the HTTP boundary, the way the
 * server answers them (`server/tests/group-ask-person.integration.test.ts` holds the server to its
 * half). Everything above it is the real GroupChat and the real badge.
 */

const CHANNEL = "group-1";
const ERRANDS = "picked-harness";
const BUDGET = "budget-buddy";
const QUESTION =
  "Where are you starting, and which errands are downtown versus in Riverside?";
const WHY =
  "The best order depends on your starting point and where the errands are.";
const ANSWER =
  "From home. Dry cleaning is downtown, groceries are in Riverside.";
const REPLY = "Do downtown first, then Riverside on the way home.";

function line(
  id: string,
  agentId: string | null,
  text: string,
  status: GroupMessage["status"] = "completed",
): GroupMessage {
  return {
    id,
    channelId: CHANNEL,
    ownerUserId: "me",
    agentId,
    text,
    status,
    createdAt: new Date().toISOString(),
  };
}

let open = true;
let messages: GroupMessage[] = [];
let answers: unknown[] = [];
let groupSends: unknown[] = [];
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
    const method = init?.method ?? "GET";
    if (url.pathname === ME_PATH)
      return meResponse({
        user: { id: "me", role: "user", email: "me@example.test" },
      });
    const bots = answerBotsList(url, init, {
      visible: [
        { id: ERRANDS, name: "Errand Helper", avatarSeed: "personal" },
        { id: BUDGET, name: "Budget Buddy", avatarSeed: BUDGET },
      ],
    });
    if (bots) return bots;
    // A message sent to the group is taken (202) to be answered there.
    if (
      url.pathname === conversationPath(CHANNEL, "/messages") &&
      method === "POST"
    ) {
      const sentMessage = JSON.parse(String(init?.body)) as { id: string };
      groupSends.push(sentMessage);
      return Response.json(
        { id: sentMessage.id, queued: true },
        { status: 202 },
      );
    }
    // The two reads the group is drawn from: its members and its lines.
    const read = answerGroupRead(url, init, CHANNEL, {
      bots: [
        { id: ERRANDS, name: "Errand Helper" },
        { id: BUDGET, name: "Budget Buddy" },
      ],
      people: [
        { userId: "me", email: "me@example.test", name: null, creator: true },
      ],
      messages,
    });
    if (read) return read;
    {
      const approvals = approvalInboxResponse(url.pathname, {
        enabled: true,
        requests: [],
        rules: [],
        teamRules: [],
        questions: open
          ? [
              {
                id: "q-1",
                botId: ERRANDS,
                conversationBotId: ERRANDS,
                // The Bot's own thread in the group, not the channel's.
                threadId: "errand-helper-group-thread",
                channelId: CHANNEL,
                question: QUESTION,
                why: WHY,
                createdAt: "2026-11-08T05:16:39.000Z",
              },
            ]
          : [],
      });
      if (approvals) return approvals;
    }
    const waiting = answerBotAttention(url, init, {
      bots: [
        attentionOf(ERRANDS, "Errand Helper", {
          questions: open ? 1 : 0,
          notify: "none",
        }),
      ],
    });
    if (waiting) return waiting;
    // As the server answers a group question: closed, the answer posted to the group, and the Bot
    // that asked queued to answer it there.
    if (
      url.pathname ===
      "/api/v2/organizations/default/people/me/questions/q-1/respond"
    ) {
      answers.push(JSON.parse(String(init?.body)));
      open = false;
      messages = [
        ...messages,
        line("person-response:q-1", null, ANSWER),
        line(`person-response:q-1:${ERRANDS}`, ERRANDS, REPLY),
      ];
      return Response.json({ id: "q-1", continueHere: false });
    }
    throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
  }) as typeof fetch;
});
beforeEach(() => {
  queryClient.clear();
  open = true;
  answers = [];
  groupSends = [];
  messages = [
    line(
      "m-1",
      null,
      "@Errand Helper which area should I do first on Saturday, downtown or Riverside? One sentence.",
    ),
    line(
      `m-1:${ERRANDS}`,
      ERRANDS,
      "Where are you starting, and which errands are in each area?",
    ),
  ];
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

function conversation() {
  return render(
    <QueryClientProvider client={queryClient}>
      <BotsNavBadge />
      <GroupChat channelId={CHANNEL} />
    </QueryClientProvider>,
  );
}

test("a Bot's question waits in the group, and answering it there clears the badge", async () => {
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  // The question is in the conversation it was asked in, with why it was asked.
  const card = await view.findByRole("region", {
    name: "Errand Helper is waiting on your answer",
  });
  expect(card.textContent).toContain(QUESTION);
  expect(card.textContent).toContain(WHY);
  await view.findByRole("img", { name: "1 thing needs you" });

  await user.type(
    await view.findByRole("textbox", { name: "Message" }),
    ANSWER,
  );
  await user.click(view.getByRole("button", { name: "Send message" }));

  // What they sent is the answer to the question, not a new message to every Bot.
  await waitFor(() => expect(answers).toEqual([{ response: ANSWER }]));
  expect(groupSends).toEqual([]);
  // Answered: the card and the badge go, and the Bot's answer to it is in the conversation.
  await waitFor(() =>
    expect(
      view.queryByRole("region", {
        name: "Errand Helper is waiting on your answer",
      }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(view.queryByRole("img", { name: /needs? you/ })).toBeNull(),
  );
  await view.findByText(ANSWER);
  await view.findByText(REPLY);
});

test("replying to one group Bot routes to it and carries its exact message, without answering another Bot's question", async () => {
  messages.push(line("budget-answer", BUDGET, "Set aside $50 for the trip."));
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await view.findByText("Set aside $50 for the trip.");
  await user.click(
    view.getAllByRole("button", { name: "Message actions" })[1]!,
  );
  await user.click(await view.findByRole("menuitem", { name: "Reply" }));
  expect(view.getByText("Replying to Budget Buddy")).toBeTruthy();
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Can we do $40?",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(groupSends).toHaveLength(1));
  const sent = groupSends[0] as { text: string; botId: string };
  expect(sent.botId).toBe(BUDGET);
  expect(splitMessageReplies(sent.text)).toEqual({
    text: "Can we do $40?",
    replies: [
      {
        messageId: "budget-answer",
        text: "Set aside $50 for the trip.",
        author: "Budget Buddy",
        botId: BUDGET,
      },
    ],
  });
  expect(answers).toEqual([]);
  expect(view.queryByRole("button", { name: "Cancel reply" })).toBeNull();
});

test("group reply threads show bot names and exclude adjacent answers from other Bots", async () => {
  open = false;
  const quote = {
    messageId: "budget-answer",
    text: "Set aside $50.",
    author: "Budget Buddy",
    botId: BUDGET,
  };
  messages = [
    line("budget-answer", BUDGET, quote.text),
    line("other-bot", ERRANDS, "Unrelated errand advice"),
    line("reply", null, withMessageReply("Can we do $40?", quote)),
    line("follow-up", BUDGET, "$40 works."),
  ];
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: "View reply thread" }),
  );
  const dialog = await view.findByRole("dialog");
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  expect(
    within(dialog).getByRole("heading", { name: "Conversation replies" }),
  ).toBeTruthy();
  expect(within(dialog).getAllByText("Budget Buddy")).toHaveLength(2);
  expect(within(dialog).getByText("Can we do $40?")).toBeTruthy();
  expect(within(dialog).queryByText("Unrelated errand advice")).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(
    view.getByRole("button", { name: "View this reply thread" }),
  );
  const reopened = await view.findByRole("dialog");
  expect(within(reopened).getByText("Can we do $40?")).toBeTruthy();
});

test("expanded threads render bot Markdown while keeping user messages literal", async () => {
  open = false;
  const quote = {
    messageId: "markdown-answer",
    text: "**Test the pilot** before investing.\n\n- Validate `demand`.\n- Read [the plan](https://example.com/plan).",
    author: "Budget Buddy",
    botId: BUDGET,
  };
  messages = [
    line(quote.messageId, BUDGET, quote.text),
    line(
      "literal-reply",
      null,
      withMessageReply("Keep **my words** exactly.", quote),
    ),
  ];
  const view = conversation();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  const preview = await view.findByRole("button", {
    name: "View reply thread",
  });
  expect(preview.textContent).toContain("Test the pilot before investing.");
  expect(preview.textContent).not.toContain("**");
  expect(preview.className).toContain("cursor-pointer");
  await user.click(preview);
  const dialog = await view.findByRole("dialog");
  expect(
    within(dialog)
      .getByText("Test the pilot")
      .closest('[data-streamdown="strong"]'),
  ).not.toBeNull();
  expect(within(dialog).getByText("demand").closest("code")).not.toBeNull();
  expect(
    within(dialog).getByRole("link", { name: "the plan" }).getAttribute("href"),
  ).toBe("https://example.com/plan");
  expect(
    dialog.querySelectorAll('[data-slot="thread-bot-message"] li'),
  ).toHaveLength(2);
  expect(within(dialog).getByText("Keep **my words** exactly.")).toBeTruthy();
});
