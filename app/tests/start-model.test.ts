import { expect, test } from "bun:test";
import { startWithModel } from "@/lib/channels/start";

/** A conversation started with a model picked before it existed. */
function steps(saveFails = false) {
  const calls: string[] = [];
  return {
    calls,
    create: async () => {
      calls.push("create");
      return { id: "c-1" };
    },
    save: async (channelId: string, model: string) => {
      calls.push(`save ${channelId} ${model}`);
      if (saveFails)
        throw new Error("That model isn't available. Pick another one.");
    },
    discard: async (channelId: string) => {
      calls.push(`discard ${channelId}`);
    },
    open: async (channelId: string) => {
      calls.push(`open ${channelId}`);
    },
  };
}

test("saves the pick before the conversation opens and sends its first message", async () => {
  const run = steps();
  await startWithModel({ model: "gpt-4o", ...run });
  expect(run.calls).toEqual(["create", "save c-1 gpt-4o", "open c-1"]);
});

test("with no pick, nothing is saved", async () => {
  const run = steps();
  await startWithModel({ model: null, ...run });
  expect(run.calls).toEqual(["create", "open c-1"]);
});

test("a pick that cannot be saved discards the conversation, opens nothing, and says why", async () => {
  const run = steps(true);
  await expect(startWithModel({ model: "gpt-4o", ...run })).rejects.toThrow(
    "That model isn't available. Pick another one.",
  );
  expect(run.calls).toEqual(["create", "save c-1 gpt-4o", "discard c-1"]);
});
