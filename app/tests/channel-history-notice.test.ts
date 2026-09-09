import { describe, expect, test } from "bun:test";
import { channelHistoryNotice } from "../src/components/channels/channel-chat";

describe("channel history notice", () => {
  test("failed history retrieval does not claim the CopilotKit project changed", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      unreadable: 0,
    });

    expect(notice).toContain("temporarily unavailable");
    expect(notice).not.toContain("different CopilotKit project");
    expect(notice).not.toContain("fresh history");
  });

  test("unreadable empty history reports holes without project-change wording", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "ready",
      unreadable: 1,
    });

    expect(notice).toContain("One earlier message could not be read");
    expect(notice).not.toContain("different CopilotKit project");
  });

  test("valid empty history in a used channel has no project-change notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
      }),
    ).toBeNull();
  });
});
