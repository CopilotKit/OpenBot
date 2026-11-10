import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * The words every Bot OpenBot ships runs on, read from the files that ship them.
 *
 * A Bot's own instructions sit beside OpenBot's prompt in the same run, and two kinds of sentence in
 * them undo it. Capitals for emphasis: a model applies an emphatic rule further than it was meant,
 * and picks it over the plain one it contradicts. And a sign-in asked for in words ("ask the person
 * to sign in, and wait for them"), which the starter Personal Assistant carried for months: OpenBot
 * hands a sign-in to the person with a tool call, so a Bot told to ask and wait stops with nothing
 * handed over, and the page stays where it was.
 *
 * Every package's `agents.yaml`, its `agents/` and its `catalog/`, so a Bot added to any of them is
 * read the day it lands.
 */
const examples = fileURLToPath(new URL("../../examples", import.meta.url));

type ShippedBot = {
  file: string;
  id: string;
  /** What the model reads: a Bot that runs here runs on `system_prompt`, a remote one on both. */
  texts: string[];
  systemPrompt: string;
};

function yamlFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

function shippedBots(): ShippedBot[] {
  const files = readdirSync(examples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name }) => {
      const pkg = join(examples, name);
      return [
        ...yamlFiles(pkg).filter((file) => /agents\.ya?ml$/.test(file)),
        ...yamlFiles(join(pkg, "agents")),
        ...yamlFiles(join(pkg, "catalog")),
      ];
    });
  return files.flatMap((file) => {
    const document = parse(readFileSync(file, "utf8")) as
      | { agents?: Record<string, unknown>[] }
      | Record<string, unknown>
      | null;
    if (!document) return [];
    const rows = Array.isArray(document.agents) ? document.agents : [document];
    return rows.map((row) => {
      const systemPrompt =
        typeof row.system_prompt === "string" ? row.system_prompt : "";
      const role =
        typeof row.role_description === "string" ? row.role_description : "";
      return {
        file: file.slice(examples.length + 1),
        id: String(row.id),
        texts: [systemPrompt, role].filter(Boolean),
        systemPrompt,
      };
    });
  });
}

/** Words in capitals that are names, not emphasis. */
const ACRONYMS = new Set(["AI", "API", "CSV", "ID", "PDF", "URL"]);

/** Any word of two or more capital letters that is not a known acronym. */
function shouting(text: string): string[] {
  return (text.match(/\b[A-Z]{2,}\b/g) ?? []).filter(
    (word) => !ACRONYMS.has(word),
  );
}

/** A sentence that asks for a sign-in, a password or a code in words and waits for it. */
function asksToSignInAndWait(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        /\b(sign(ed)?[ -]?in|log(ged)?[ -]?in|password|passcode)\b/i.test(
          sentence,
        ) &&
        (/\bwait\b/i.test(sentence) ||
          /\bask (them|the person|the user) to (sign|log)[ -]?in\b/i.test(
            sentence,
          )),
    );
}

test("the rules catch the wording the starter shipped with", () => {
  const earlier =
    "Be clear and brief, and ask when something is ambiguous rather than guessing. Never type a password yourself: ask the person to sign in, and wait for them.";
  expect(asksToSignInAndWait(earlier)).toEqual([
    "Never type a password yourself: ask the person to sign in, and wait for them.",
  ]);
  expect(shouting("Report it as WITHIN POLICY. Do NOT browse.")).toEqual([
    "WITHIN",
    "POLICY",
    "NOT",
  ]);
  expect(shouting("Read the PDF at the URL.")).toEqual([]);
});

test("OpenBot ships the Bots this reads", () => {
  const ids = shippedBots().map(({ id }) => id);
  for (const id of [
    "personal-assistant",
    "general-assistant",
    "knowledge",
    "expense-review",
    "research-desk",
  ])
    expect(ids).toContain(id);
});

test("no Bot OpenBot ships is told anything in capitals for emphasis", () => {
  const found = shippedBots().flatMap(({ file, id, texts }) =>
    texts.flatMap((text) =>
      shouting(text).map((word) => `${file} ${id}: ${word}`),
    ),
  );
  expect(found).toEqual([]);
});

test("no Bot OpenBot ships is told to ask for a sign-in and wait", () => {
  const found = shippedBots().flatMap(({ file, id, texts }) =>
    texts.flatMap((text) =>
      asksToSignInAndWait(text).map((sentence) => `${file} ${id}: ${sentence}`),
    ),
  );
  expect(found).toEqual([]);
});

/*
 * The starter's instructions are edited on its Setup page, which refuses more than 1,000 characters;
 * shipped longer, the person could not save a one-word change without cutting ours first. Every other
 * Bot here is a template somebody copies into a Bot of their own, under the same limit.
 */
test("every shipped Bot's instructions fit the 1,000 characters a Bot's form allows", () => {
  const over = shippedBots()
    .filter(({ systemPrompt }) => systemPrompt.length > 1000)
    .map(
      ({ file, id, systemPrompt }) => `${file} ${id}: ${systemPrompt.length}`,
    );
  expect(over).toEqual([]);
});
