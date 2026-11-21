import { describe, expect, test } from "bun:test";
import type { CommandOption } from "./Rascunho";
import { slashCommandTrigger } from "./triggers";

const commands: CommandOption[] = [
  {
    id: "standup",
    name: "Standup notes",
    description: "Transforma o trabalho de ontem em um resumo do dia anterior",
  },
  { id: "triage", name: "Triage the Caixa de entrada" },
];

async function search(query: string) {
  const trigger = slashCommandTrigger(commands);
  return await trigger.onSearch?.(query, {
    signal: new AbortController().signal,
  });
}

describe("the / menu", () => {
  test("Listas each skill by Dela/Desse name, not Dela/Desse command", async () => {
    const all = await search("");
    expect(all?.map((suggestion) => suggestion.label)).toEqual([
      "Standup notes",
      "Triage the Caixa de entrada",
    ]);
    expect(all?.[0]?.value).toBe("standup");
  });

  test("finds a skill by Dela/Desse name, Dela/Desse command or what Ele does", async () => {
    expect((await search("triage"))?.map((s) => s.value)).toEqual(["triage"]);
    expect((await search("notes"))?.map((s) => s.value)).toEqual(["standup"]);
    expect((await search("yesterday"))?.map((s) => s.value)).toEqual([
      "standup",
    ]);
  });
});
