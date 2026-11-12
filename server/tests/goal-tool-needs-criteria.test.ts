import { expect, test } from "bun:test";
import { responsibilityTools } from "../src/responsibilities/tools";
import type { ResponsibilityStore } from "../src/responsibilities/types";

function setup() {
  const created: unknown[] = [];
  const store = {
    async create(_owner: string, input: unknown) {
      created.push(input);
      return { id: "g1" };
    },
  } as unknown as ResponsibilityStore;
  const tools = responsibilityTools({
    store,
    engine: { ingest: async () => ({}) } as never,
    ownerUserId: "o",
    agentId: "a",
    channelId: "c",
  });
  const createGoal = tools.find((t) => t.name === "create_goal");
  if (!createGoal) throw new Error("create_goal missing");
  return { created, createGoal };
}

test("create_goal without success criteria is refused and nothing is stored", async () => {
  const { created, createGoal } = setup();
  const result = await createGoal.execute({ title: "T", instruction: "I" });
  expect(String(result)).toStartWith("Refused.");
  expect(created).toHaveLength(0);
});

test("create_goal with success criteria reaches the store", async () => {
  const { created, createGoal } = setup();
  await createGoal.execute({
    title: "T",
    instruction: "I",
    successCriteria: "Done",
  });
  expect(created).toHaveLength(1);
});
