import { expect, test } from "bun:test";
import { startGroupWith } from "../src/lib/channels/start";

/**
 * A conversation started with two or more Bots in the To: field is a group: created with the Bots in
 * the order they were picked, then given the first message, then opened. Nothing is sent if the
 * group could not be made.
 */

test("creates the group in pick order, sends the first message, then opens it", async () => {
  const calls: string[] = [];
  await startGroupWith({
    agentIds: ["knowledge", "risk-analyst"],
    text: "Compare the two policies.",
    create: async (agentIds) => {
      calls.push(`create ${agentIds.join(",")}`);
      return { id: "channel-1" };
    },
    send: async (channelId, text) => {
      calls.push(`send ${channelId} ${text}`);
    },
    open: async (channelId) => {
      calls.push(`open ${channelId}`);
    },
  });
  expect(calls).toEqual([
    "create knowledge,risk-analyst",
    "send channel-1 Compare the two policies.",
    "open channel-1",
  ]);
});

test("a group that could not be made sends nothing and opens nothing", async () => {
  const calls: string[] = [];
  await expect(
    startGroupWith({
      agentIds: ["knowledge", "risk-analyst"],
      text: "Hello.",
      create: async () => {
        throw new Error("The group could not be started.");
      },
      send: async () => {
        calls.push("send");
      },
      open: async () => {
        calls.push("open");
      },
    }),
  ).rejects.toThrow("The group could not be started.");
  expect(calls).toEqual([]);
});
