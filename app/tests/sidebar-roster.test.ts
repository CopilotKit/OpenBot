import { describe, expect, test } from "bun:test";
import {
  conversationRoster,
  matchingRoster,
  rosterDestination,
  rosterKey,
  rosterLastMessage,
  rosterName,
  shouldShowEmptyRoster,
  shouldShowSearchEmpty,
} from "../src/components/app-sidebar/roster";
import type { ChannelSummary } from "../src/lib/channels/queries";
import type { ExternalThreadSummary } from "../src/lib/external/queries";

function channel(
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: `Channel ${id}`,
    agentIds: [`agent-${id}`],
    threadId: `thread-${id}`,
    active: true,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-08-25T10:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function slack(
  threadId: string,
  overrides: Partial<ExternalThreadSummary> = {},
): ExternalThreadSummary {
  return {
    threadId,
    provider: "slack",
    agentId: `agent-${threadId}`,
    agentName: `Slack ${threadId}`,
    lastMessage: null,
    lastMessageAt: null,
    createdAt: "2026-08-25T10:00:00.000Z",
    readOnly: true,
    ...overrides,
  };
}

describe("sidebar conversation roster", () => {
  test("sorts pinned native channels first, then remaining rows by activity and stable key", () => {
    const rows = conversationRoster(
      [
        channel("unpinned-new", {
          createdAt: "2026-08-25T11:00:00.000Z",
        }),
        channel("pinned-old", {
          createdAt: "2026-08-24T11:00:00.000Z",
          pinned: true,
        }),
        channel("tie-z", {
          createdAt: "2026-08-25T12:00:00.000Z",
        }),
        channel("tie-a", {
          createdAt: "2026-08-25T12:00:00.000Z",
        }),
      ],
      [
        slack("slack-newest", {
          lastMessageAt: "2026-08-25T13:00:00.000Z",
          createdAt: "2026-08-25T09:00:00.000Z",
        }),
        slack("slack-tie", {
          createdAt: "2026-08-25T12:00:00.000Z",
        }),
      ],
    );

    expect(rows.map(rosterKey)).toEqual([
      "openbot:pinned-old",
      "slack:slack-newest",
      "openbot:tie-a",
      "openbot:tie-z",
      "slack:slack-tie",
      "openbot:unpinned-new",
    ]);
  });

  test("matches visible names and last-message text across native and Slack rows", () => {
    const rows = conversationRoster(
      [
        channel("alpha", {
          name: "Roadmap",
          lastMessage: "Budget review",
        }),
      ],
      [
        slack("beta", {
          agentName: "Support Slack",
          lastMessage: "Incident handoff",
        }),
      ],
    );

    expect(matchingRoster(rows, "road").map(rosterKey)).toEqual([
      "openbot:alpha",
    ]);
    expect(matchingRoster(rows, "handoff").map(rosterKey)).toEqual([
      "slack:beta",
    ]);
    expect(matchingRoster(rows, "support").map(rosterKey)).toEqual([
      "slack:beta",
    ]);
    expect(matchingRoster(rows, "missing")).toEqual([]);
    expect(matchingRoster(rows, "   ")).toBe(rows);
  });

  test("projects names, previews, and destinations for both row sources", () => {
    const nativeRow = conversationRoster([
      channel("native", { name: "Native", lastMessage: "OpenBot preview" }),
    ])[0];
    const slackRow = conversationRoster(
      [],
      [
        slack("slack-thread", {
          agentName: "Slack Agent",
          lastMessage: "Slack preview",
        }),
      ],
    )[0];

    expect(rosterName(nativeRow)).toBe("Native");
    expect(rosterLastMessage(nativeRow)).toBe("OpenBot preview");
    expect(rosterDestination(nativeRow)).toEqual({
      to: "/channel/$channelId",
      params: { channelId: "native" },
    });

    expect(rosterName(slackRow)).toBe("Slack Agent");
    expect(rosterLastMessage(slackRow)).toBe("Slack preview");
    expect(rosterDestination(slackRow)).toEqual({
      to: "/slack/thread/$threadId",
      params: { threadId: "slack-thread" },
    });
  });

  test("shows the empty roster only after both sources have loaded empty arrays", () => {
    expect(shouldShowEmptyRoster([], [], true, true)).toBe(true);
    expect(shouldShowEmptyRoster([channel("native")], [], true, true)).toBe(
      false,
    );
    expect(shouldShowEmptyRoster([], [slack("external")], true, true)).toBe(
      false,
    );
    expect(shouldShowEmptyRoster([], [], false, true)).toBe(false);
    expect(shouldShowEmptyRoster([], [], true, false)).toBe(false);
  });

  test("shows search-empty only once both sources successfully loaded and the merged result is empty", () => {
    const match = conversationRoster([channel("native")]);

    expect(shouldShowSearchEmpty([], "missing", "success", "pending")).toBe(
      false,
    );
    expect(shouldShowSearchEmpty([], "missing", "pending", "success")).toBe(
      false,
    );
    expect(shouldShowSearchEmpty([], "missing", "success", "error")).toBe(
      false,
    );
    expect(shouldShowSearchEmpty([], "missing", "success", "success")).toBe(
      true,
    );
    expect(shouldShowSearchEmpty(match, "native", "success", "success")).toBe(
      false,
    );
    expect(shouldShowSearchEmpty([], "   ", "success", "success")).toBe(false);
  });
});
