import { expect, test } from "bun:test";
import { answerInOrder } from "../src/browser-order";

/**
 * One step's tool calls, as a model that calls tools in parallel sends a form: a Bot has one browser, so its computer
 * calls run one after another in the order they were made, while anything else runs beside them.
 */
test("computer calls made together run one at a time, in order, and the rest alongside", async () => {
  const calls = [
    { name: "computer_type", id: "name" },
    { name: "computer_type", id: "website" },
    { name: "search_web", id: "lookup" },
    { name: "computer_click", id: "save" },
  ];
  const started: string[] = [];
  let running = 0;
  let most = 0;
  let lookupBeside = false;
  const answers = await answerInOrder(calls, async (call) => {
    started.push(call.id);
    const computer = call.name.startsWith("computer_");
    if (computer) most = Math.max(most, ++running);
    // Long enough that calls sent together would overlap; the first is the slowest, so nothing can finish ahead of it
    // by chance.
    await Bun.sleep(call.id === "name" ? 60 : 20);
    if (computer) running -= 1;
    // The lookup finishes while the first field is still being typed.
    else lookupBeside = running > 0;
    return `answered ${call.id}`;
  });
  expect(most).toBe(1);
  expect(started.filter((id) => id !== "lookup")).toEqual([
    "name",
    "website",
    "save",
  ]);
  expect(lookupBeside).toBe(true);
  expect(answers).toEqual(calls.map((call) => `answered ${call.id}`));
});
