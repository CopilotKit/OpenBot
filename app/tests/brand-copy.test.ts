import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { reachSummary } from "../src/lib/agents/bot-summaries";
import { appConfig } from "../src/lib/generated/application-config";

/**
 * The product's name in what a person reads comes from the tenant package, never a literal.
 *
 * A fork that renames the product changes `brand.yaml`, and every sentence follows. A sentence that
 * spells the template's name itself shows it to every tenant, and nothing else would notice: the
 * default package is called OpenBot, so the tests that read that sentence still pass.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Names of other things that ship under the template's name, not the product a person is in. */
const OTHER_PRODUCTS = /^OpenBot (Recorder|Desktop|desktop|app\b)/;

/**
 * Files allowed to say it: text written for the model rather than a person, and a message only a
 * developer sees when the page has no root element.
 */
const ALLOWED = new Set(["lib/copilot/generative-ui.ts", "main.tsx"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "generated" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

/** Comments blanked where they stand, so a line number found afterwards is the file's own. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(?<![:"'`])\/\/[^\n]*/g, "");
}

describe("the product name in the app's copy", () => {
  test("no source file spells the template's name where a person reads it", () => {
    const literals: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const file = relative(SRC, path).replaceAll("\\", "/");
      if (ALLOWED.has(file)) continue;
      const source = withoutComments(readFileSync(path, "utf8"));
      for (const match of source.matchAll(/(?<!\w)OpenBot(?!\w)/g)) {
        if (OTHER_PRODUCTS.test(source.slice(match.index))) continue;
        const line = source.slice(0, match.index).split("\n").length;
        literals.push(`${file}:${line}`);
      }
    }

    // Write `appConfig.brand.productName` instead.
    expect(literals).toEqual([]);
  });

  test("a sentence built at call time says whatever the package calls the product", () => {
    const configured = appConfig.brand.productName;
    try {
      appConfig.brand.productName = "NexQN AI";
      expect(reachSummary([])).toBe("Only in NexQN AI");
    } finally {
      appConfig.brand.productName = configured;
    }
  });
});
