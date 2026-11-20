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
    discard: async (channelId) => {
      calls.push(`discard ${channelId}`);
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

test("a first message that does not send discards the empty group and opens nothing", async () => {
  const calls: string[] = [];
  await expect(
    startGroupWith({
      agentIds: ["knowledge", "risk-analyst"],
      text: "Compare the two policies.",
      create: async () => {
        calls.push("create");
        return { id: "channel-1" };
      },
      send: async () => {
        throw new Error("Your message could not be sent to the group.");
      },
      discard: async (channelId) => {
        calls.push(`discard ${channelId}`);
      },
      open: async () => {
        calls.push("open");
      },
    }),
  ).rejects.toThrow("Your message could not be sent to the group.");
  expect(calls).toEqual(["create", "discard channel-1"]);
});

test("a discard that also fails still reports the message's failure, not the discard's", async () => {
  await expect(
    startGroupWith({
      agentIds: ["knowledge", "risk-analyst"],
      text: "Hello.",
      create: async () => ({ id: "channel-1" }),
      send: async () => {
        throw new Error("Your message could not be sent to the group.");
      },
      discard: async () => {
        throw new Error("Could not delete this channel");
      },
      open: async () => undefined,
    }),
  ).rejects.toThrow("Your message could not be sent to the group.");
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
      discard: async () => {
        calls.push("discard");
      },
      open: async () => {
        calls.push("open");
      },
    }),
  ).rejects.toThrow("The group could not be started.");
  expect(calls).toEqual([]);
});
