import { expect, test } from "bun:test";
import { startWithModel } from "@/lib/channels/start";
import type { ConversationModel } from "@/lib/models/queries";

/** A conversation started with a model and effort picked before it existed. */
function steps(saveFails = false) {
  const calls: string[] = [];
  return {
    calls,
    create: async () => {
      calls.push("create");
      return { id: "c-1" };
    },
    save: async (channelId: string, pick: ConversationModel) => {
      calls.push(`save ${channelId} ${pick.model} ${pick.effort}`);
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

test("saves the model and effort before the conversation opens and sends its first message", async () => {
  const run = steps();
  await startWithModel({ pick: { model: "gpt-4o", effort: "high" }, ...run });
  expect(run.calls).toEqual(["create", "save c-1 gpt-4o high", "open c-1"]);
});

test("an effort on the default model is saved on its own", async () => {
  const run = steps();
  await startWithModel({ pick: { model: null, effort: "low" }, ...run });
  expect(run.calls).toEqual(["create", "save c-1 null low", "open c-1"]);
});

test("with no pick, nothing is saved", async () => {
  const run = steps();
  await startWithModel({ pick: null, ...run });
  await startWithModel({ pick: { model: null, effort: null }, ...run });
  expect(run.calls).toEqual(["create", "open c-1", "create", "open c-1"]);
});

test("a pick that cannot be saved discards the conversation, opens nothing, and says why", async () => {
  const run = steps(true);
  await expect(
    startWithModel({ pick: { model: "gpt-4o", effort: null }, ...run }),
  ).rejects.toThrow("That model isn't available. Pick another one.");
  expect(run.calls).toEqual(["create", "save c-1 gpt-4o null", "discard c-1"]);
});
