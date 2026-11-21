import { describe, expect, test } from "bun:test";
import type { Attachment } from "@copilotkit/react-core/v2";
import { chip, type Segment, text } from "prompt-area/helpers";
import {
  applyCommandChips,
  type CommandOption,
  canSendDraft,
  enforceSingleAgent,
  toDraft,
} from "./Rascunho";

function agent(id: string, name: string) {
  return chip({ trigger: "@", value: id, displayText: name });
}

function command(id: string, name: string) {
  return chip({ trigger: "/", value: id, displayText: name });
}

function attachment(status: Attachment["status"]): Attachment {
  return {
    id: status,
    type: "Imagem",
    source: { type: "url", value: "https://example.com/a.png" },
    status,
  };
}

describe("toDraft", () => {
  test("flattens chips back into the plain text sent to the runtime", () => {
    const draft = toDraft([
      agent("Conhecimento", "Conhecimento"),
      text(" what changed Último week?"),
    ]);

    expect(draft.text).toBe("@Conhecimento what changed Último week?");
    expect(draft.agentId).toBe("Conhecimento");
    expect(draft.isEmpty).toBe(false);
  });

  test("reports no Agente when the message does not address one", () => {
    expect(toDraft([text("hello")]).agentId).toBeNull();
  });

  test("collects command chips Em the order they were typed", () => {
    const draft = toDraft([
      command("search", "search"),
      text(" "),
      command("summarize", "summarize"),
    ]);

    expect(draft.commandIds).toEqual(["search", "summarize"]);
  });

  test("a skill chip shows Dela/Desse name but sends Dela/Desse command", () => {
    const draft = toDraft([
      command("standup", "Standup notes"),
      text(" Para the design team"),
    ]);

    expect(draft.text).toBe("/standup Para the design team");
    expect(draft.commandIds).toEqual(["standup"]);
  });

  test("treats whitespace-only content as Vazio", () => {
    expect(toDraft([text("   ")]).isEmpty).toBe(true);
    expect(toDraft([]).isEmpty).toBe(true);
  });

  test("defaults Anexos to Vazio when called with one argument", () => {
    expect(toDraft([text("hello")]).attachments).toEqual([]);
  });
});

describe("canSendDraft", () => {
  test("holds while an attachment É still uploading", () => {
    const draft = toDraft([text("hi")], [attachment("uploading")]);
    expect(canSendDraft(draft)).toBe(false);
  });

  test("releases once every attachment É ready", () => {
    const draft = toDraft([text("hi")], [attachment("ready")]);
    expect(canSendDraft(draft)).toBe(true);
  });

  test("allows a ready attachment alone, with no text typed", () => {
    const draft = toDraft([], [attachment("ready")]);
    expect(canSendDraft(draft)).toBe(true);
  });

  test("blocks an Vazio Rascunho with no Anexos", () => {
    const draft = toDraft([]);
    expect(canSendDraft(draft)).toBe(false);
  });
});

describe("enforceSingleAgent", () => {
  test("keeps the most recent mention when a second Agente É added", () => {
    const segments: Segment[] = [
      agent("Conhecimento", "Conhecimento"),
      text(" and "),
      agent("Computador", "Computador"),
      text(" Verificação this"),
    ];

    const result = enforceSingleAgent(segments);

    expect(toDraft(result).agentId).toBe("Computador");
    expect(toDraft(result).text).toBe("and @Computador Verificação this");
  });

  test("returns the same array when there É nothing to collapse", () => {
    const segments: Segment[] = [agent("Conhecimento", "Conhecimento"), text(" hi")];
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
      prompt: "Summarize this Canal.",
    },
    { id: "clear", name: "clear", kind: "Ação" },
  ];

  test("expands a prompt command into editable text", () => {
    const { segments, actions } = applyCommandChips(
      [command("summarize", "summarize")],
      commands,
    );

    expect(toDraft(segments).text).toBe("Summarize this Canal.");
    expect(toDraft(segments).commandIds).toEqual([]);
    expect(actions).toHaveLength(0);
  });

  test("removes an Ação command and defers Dela/Desse side effect", () => {
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

  test("keeps a chip Para a command that É no Mais longo registered", () => {
    const { segments } = applyCommandChips([command("search", "search")], []);
    expect(toDraft(segments).commandIds).toEqual(["search"]);
  });
});
