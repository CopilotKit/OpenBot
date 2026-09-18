import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTenantPackage,
  validateTenantPackage,
} from "../src/tenant-package";

/**
 * A coworker as a file of its own.
 *
 * `agents.yaml` holds every coworker a package ships, so adding one means editing a file somebody
 * else is editing too, and handing somebody a coworker means handing them a fragment to paste into
 * the middle of theirs. A directory beside it makes a coworker a file: copy it in, delete it, send
 * it. These cases are the ones that decide whether both can be read at once without the package
 * becoming ambiguous about which coworkers it declares.
 *
 * Kept out of `tenant-package.test.ts` because everything here is about parsing files, and that
 * suite opens a database at import.
 */

const base = {
  brand: "tenant: { id: fintech, product_name: Ledgerline }",
  agents:
    "agents: [{ id: knowledge, name: Knowledge, title: Company Knowledge, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]",
  channels: "channels: []",
  model:
    "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
  knowledge: "sources: []",
  themeCss: "",
};

const expenseReview = `id: expense-review
name: Expense Review
title: Finance Operations
role_description: Check one expense claim against the policy as it is written.
type: built-in
system_prompt: Quote the clause you relied on, and leave the decision to a person.
`;

describe("a coworker declared in a file of its own", () => {
  test("is loaded alongside the ones in agents.yaml", () => {
    const { agents } = validateTenantPackage({
      ...base,
      agentFiles: [
        { filename: "expense-review.yaml", contents: expenseReview },
      ],
    });

    expect(agents.map((agent) => agent.id)).toEqual([
      "knowledge",
      "expense-review",
    ]);
    expect(agents[1]).toMatchObject({
      id: "expense-review",
      name: "Expense Review",
      type: "built_in",
      configuration: {
        systemPrompt:
          "Quote the clause you relied on, and leave the decision to a person.",
      },
    });
  });

  test("may also be written as a list, the way agents.yaml is", () => {
    // Somebody splitting an existing `agents.yaml` up copies the list syntax across with it, and a
    // file that parses one way and not the other would make that a puzzle rather than a move.
    const { agents } = validateTenantPackage({
      ...base,
      agentFiles: [
        {
          filename: "pair.yaml",
          contents: `agents:\n${expenseReview
            .trimEnd()
            .split("\n")
            .map((line, index) => (index === 0 ? `  - ${line}` : `    ${line}`))
            .join("\n")}\n`,
        },
      ],
    });

    expect(agents.map((agent) => agent.id)).toEqual([
      "knowledge",
      "expense-review",
    ]);
  });

  test("is refused when another file already declares that id, and both are named", () => {
    // Preferring one would make the roster depend on the order a directory was read in, and a
    // clone that copied the same coworker in twice would never be told.
    expect(() =>
      validateTenantPackage({
        ...base,
        agentFiles: [
          {
            filename: "knowledge.yaml",
            contents: expenseReview.replace("expense-review", "knowledge"),
          },
        ],
      }),
    ).toThrow(
      'agent "knowledge" is declared in both agents.yaml and agents/knowledge.yaml',
    );
  });

  test("is refused for the same reasons a row in agents.yaml is, and says which file", () => {
    expect(() =>
      validateTenantPackage({
        ...base,
        agentFiles: [
          {
            filename: "broken.yaml",
            contents: expenseReview.replace("type: built-in", "type: smoke"),
          },
        ],
      }),
    ).toThrow("agents/broken.yaml: agent.type must be built-in");
  });

  test("names a skill this package does not ship and is refused", () => {
    // The check that already protects `agents.yaml` reaches a coworker arriving this way too, so a
    // typo in a file somebody copied in fails at boot rather than attaching nothing in silence.
    expect(() =>
      validateTenantPackage({
        ...base,
        agentFiles: [
          {
            filename: "expense-review.yaml",
            contents: `${expenseReview}skills:\n  - quote-the-expense-policy\n`,
          },
        ],
      }),
    ).toThrow(
      'agent "expense-review" names skill "quote-the-expense-policy", which this package does not ship',
    );
  });
});

describe("reading the agents directory from disk", () => {
  async function packageWith(files: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), "openbot-package-"));
    await cp(
      fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
      directory,
      { recursive: true },
    );
    await mkdir(join(directory, "agents"), { recursive: true });
    for (const [filename, contents] of Object.entries(files)) {
      await writeFile(join(directory, "agents", filename), contents, "utf8");
    }
    return directory;
  }

  test("a package with no agents directory loads exactly as it did", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-package-"));
    await cp(
      fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
      directory,
      { recursive: true },
    );
    await rm(join(directory, "agents"), { recursive: true, force: true });

    const tenantPackage = await loadTenantPackage(directory);

    expect(
      tenantPackage.agents.some((agent) => agent.id === "general-assistant"),
    ).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  test("files are read in filename order, and anything that is not YAML is left alone", async () => {
    const directory = await packageWith({
      "b-second.yaml": expenseReview.replaceAll("expense-review", "second"),
      "a-first.yml": expenseReview.replaceAll("expense-review", "first"),
      "README.md": "Not a coworker, and not something to parse.",
    });

    const { agents } = await loadTenantPackage(directory);
    const added = agents
      .map((agent) => agent.id)
      .filter((id) => id === "first" || id === "second");

    expect(added).toEqual(["first", "second"]);
    await rm(directory, { recursive: true, force: true });
  });

  test("editing one of those files changes the package checksum", async () => {
    // The checksum is how a running deployment notices the repository said something new. A
    // coworker added or edited here is a package change like any other.
    const directory = await packageWith({
      "expense-review.yaml": expenseReview,
    });
    const before = (await loadTenantPackage(directory)).checksum;

    await writeFile(
      join(directory, "agents", "expense-review.yaml"),
      expenseReview.replace("Finance Operations", "Finance"),
      "utf8",
    );
    const after = (await loadTenantPackage(directory)).checksum;

    expect(after).not.toBe(before);
    await rm(directory, { recursive: true, force: true });
  });
});
