import { describe, expect, test } from "bun:test";
import type { CommandOption } from "./draft";
import { slashCommandTrigger } from "./triggers";

const commands: CommandOption[] = [
  {
    id: "standup",
    name: "Standup notes",
    description: "Turns yesterday's work into a standup update",
  },
  { id: "triage", name: "Triage the inbox" },
];

async function search(query: string) {
  const trigger = slashCommandTrigger(commands);
  return await trigger.onSearch?.(query, {
    signal: new AbortController().signal,
  });
}

describe("the / menu", () => {
  test("lists each skill by its name, not its command", async () => {
    const all = await search("");
    expect(all?.map((suggestion) => suggestion.label)).toEqual([
      "Standup notes",
      "Triage the inbox",
    ]);
    expect(all?.[0]?.value).toBe("standup");
  });

  test("finds a skill by its name, its command or what it does", async () => {
    expect((await search("triage"))?.map((s) => s.value)).toEqual(["triage"]);
    expect((await search("notes"))?.map((s) => s.value)).toEqual(["standup"]);
    expect((await search("yesterday"))?.map((s) => s.value)).toEqual([
      "standup",
    ]);
  });
});
