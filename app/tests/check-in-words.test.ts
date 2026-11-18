import { expect, test } from "bun:test";
import { checkInMessage } from "@openbot/shared/check-in-message";
import { matchingChannels } from "@/components/app-sidebar/app-sidebar";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { ChannelActivityEvent } from "@/lib/channels/use-channel-events";
import { conversationLabel, conversationTitle } from "@/lib/channels/label";
import { replyNotice } from "@/lib/notifications/reply-notice";

/**
 * A check-in speaking first is a Bot's message with a marker in front of its sentence. The
 * transcript reads the marker and draws cards. Everywhere else a message is shown as a line of
 * words, and there it is the sentence: the conversation's row before it has a name, a search over
 * loaded rows, a picker's label, and the notice a reply raises while OpenBot is out of sight.
 */

const SENTENCE = "Good morning. Two emails need you today.";
const spoke = checkInMessage({
  checkInId: "chk_inbox",
  ranAt: "2026-11-17T16:00:00.000Z",
  itemIds: ["itm_rosa", "itm_northwind"],
  message: SENTENCE,
});

/** The conversation a check-in opened for itself: no first words from a person, one Bot message. */
function conversation(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "channel-check-in",
    name: "General Assistant",
    agentIds: ["general-assistant"],
    threadId: "thread-check-in",
    active: true,
    summary: null,
    lastMessage: spoke,
    lastMessageAt: "2026-11-17T16:00:00.000Z",
    lastMessageAgentId: "general-assistant",
    createdAt: "2026-11-17T16:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

test("its row is called by the sentence until the conversation has a name", () => {
  expect(conversationTitle(conversation())).toBe(SENTENCE);
  expect(conversationLabel(conversation())).toBe(
    `General Assistant: ${SENTENCE}`,
  );
});

test("and by its name once it has one", () => {
  expect(conversationTitle(conversation({ summary: "Inbox check-in" }))).toBe(
    "Inbox check-in",
  );
});

test("it is found by a word of the sentence", () => {
  expect(
    matchingChannels([conversation()], "two emails").map((row) => row.id),
  ).toEqual(["channel-check-in"]);
});

test("it is not found by what is in the marker, which no row shows", () => {
  for (const hidden of ["check-in]", "itemIds", "itm_rosa", "chk_inbox"]) {
    expect(matchingChannels([conversation()], hidden)).toEqual([]);
  }
});

/** A Bot's reply as the conversation events socket announces it. */
function reply(overrides: Partial<ChannelActivityEvent>): ChannelActivityEvent {
  return {
    channelId: "channel-check-in",
    lastMessage: spoke,
    lastMessageAt: "2026-11-17T16:00:00.000Z",
    lastMessageAgentId: "general-assistant",
    ...overrides,
  };
}

const bots = [{ id: "general-assistant", name: "General Assistant" }];

test("the notice it raises says the sentence, from the first line the server sends", () => {
  expect(
    replyNotice(reply({ firstLine: spoke }), "all", [], bots),
  ).toMatchObject({ title: "General Assistant replied", body: SENTENCE });
});

test("and from the preview, for a server that sends no first line", () => {
  expect(replyNotice(reply({}), "all", [], bots)?.body).toBe(SENTENCE);
});

test("a first line the server already wrote as words is left as it is", () => {
  expect(
    replyNotice(reply({ firstLine: SENTENCE }), "all", [], bots)?.body,
  ).toBe(SENTENCE);
});

test("an ordinary reply's notice is unchanged", () => {
  expect(
    replyNotice(
      reply({
        firstLine: "Filed the report.",
        lastMessage: "Filed the report.",
      }),
      "all",
      [],
      bots,
    )?.body,
  ).toBe("Filed the report.");
});
