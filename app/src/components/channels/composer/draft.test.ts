import { describe, expect, test } from "bun:test";
import { chip, type Segment, text } from "prompt-area/helpers";
import {
  applyCommandChips,
  type CommandOption,
  enforceSingleAgent,
  toDraft,
} from "./draft";

function agent(id: string, name: string) {
  return chip({ trigger: "@", value: id, displayText: name });
}

function command(id: string, name: string) {
  return chip({ trigger: "/", value: id, displayText: name });
}

describe("toDraft", () => {
  test("flattens chips back into the plain text sent to the runtime", () => {
    const draft = toDraft([
      agent("knowledge", "Knowledge"),
      text(" what changed last week?"),
    ]);

    expect(draft.text).toBe("@Knowledge what changed last week?");
    expect(draft.agentId).toBe("knowledge");
    expect(draft.isEmpty).toBe(false);
  });

  test("reports no agent when the message does not address one", () => {
    expect(toDraft([text("hello")]).agentId).toBeNull();
  });

  test("collects command chips in the order they were typed", () => {
    const draft = toDraft([
      command("search", "search"),
      text(" "),
      command("summarize", "summarize"),
    ]);

    expect(draft.commandIds).toEqual(["search", "summarize"]);
  });

  test("treats whitespace-only content as empty", () => {
    expect(toDraft([text("   ")]).isEmpty).toBe(true);
    expect(toDraft([]).isEmpty).toBe(true);
  });
});

describe("enforceSingleAgent", () => {
  test("keeps the most recent mention when a second agent is added", () => {
    const segments: Segment[] = [
      agent("knowledge", "Knowledge"),
      text(" and "),
      agent("computer", "Computer"),
      text(" check this"),
    ];

    const result = enforceSingleAgent(segments);

    expect(toDraft(result).agentId).toBe("computer");
    expect(toDraft(result).text).toBe("and @Computer check this");
  });

  test("returns the same array when there is nothing to collapse", () => {
    const segments: Segment[] = [agent("knowledge", "Knowledge"), text(" hi")];
    expect(enforceSingleAgent(segments)).toBe(segments);
  });
});

describe("applyCommandChips", () => {
  const commands: CommandOption[] = [
    { id: "search", name: "search", kind: "chip" },
    {
      id: "summarize",
      name: "summarize",
      kind: "prompt",
      prompt: "Summarize this channel.",
    },
    { id: "clear", name: "clear", kind: "action" },
  ];

  test("expands a prompt command into editable text", () => {
    const { segments, actions } = applyCommandChips(
      [command("summarize", "summarize")],
      commands,
    );

    expect(toDraft(segments).text).toBe("Summarize this channel.");
    expect(toDraft(segments).commandIds).toEqual([]);
    expect(actions).toHaveLength(0);
  });

  test("removes an action command and defers its side effect", () => {
    let ran = false;
    const { segments, actions } = applyCommandChips(
      [command("clear", "clear")],
      commands.map((entry) =>
        entry.id === "clear" ? { ...entry, run: () => (ran = true) } : entry,
      ),
    );

    expect(toDraft(segments).isEmpty).toBe(true);
    expect(actions).toHaveLength(1);
    expect(ran).toBe(false);

    for (const action of actions) {
      action();
    }
    expect(ran).toBe(true);
  });

  test("leaves chip commands alone and returns the same array", () => {
    const segments: Segment[] = [
      command("search", "search"),
      text(" invoices"),
    ];
    const result = applyCommandChips(segments, commands);

    expect(result.segments).toBe(segments);
    expect(result.actions).toHaveLength(0);
  });

  test("keeps a chip for a command that is no longer registered", () => {
    const { segments } = applyCommandChips([command("search", "search")], []);
    expect(toDraft(segments).commandIds).toEqual(["search"]);
  });
});
