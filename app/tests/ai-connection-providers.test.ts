import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_PROVIDERS } from "@/lib/ai-connection/providers";

/**
 * Settings offers the same providers as Desktop's setup window, in its order, with its names,
 * summaries, ways in and marks. The setup window's list is `catalogue()` in
 * desktop/src-tauri/src/provider.rs; a change there that Settings does not follow fails here.
 */
const rust = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "desktop",
    "src-tauri",
    "src",
    "provider.rs",
  ),
  "utf8",
);

const LOGINS: Record<string, string> = {
  Plan: "plan",
  ApiKey: "api-key",
  Endpoint: "endpoint",
  Oauth: "oauth",
};

/** Each `Provider { ... }` in the catalogue, read for the fields Settings draws. */
function catalogue() {
  const body = rust.slice(rust.indexOf("pub fn catalogue()"));
  return [...body.matchAll(/Provider \{([\s\S]*?)caution:/g)].map((match) => {
    const block = match[1] ?? "";
    const field = (name: string) =>
      new RegExp(`${name}: "([^"]*)"\\.into\\(\\)`).exec(block)?.[1];
    const logins = /logins: vec!\[([^\]]*)\]/.exec(block)?.[1] ?? "";
    const mark = /mark: (None|Some\("([^"]*)"\.into\(\)\))/.exec(block);
    return {
      id: field("id"),
      name: field("name"),
      summary: field("summary"),
      logins: [...logins.matchAll(/Login::(\w+)/g)].map(
        (login) => LOGINS[login[1] ?? ""],
      ),
      mark: mark?.[2] ?? null,
    };
  });
}

test("Settings lists the setup window's providers, in its order and words", () => {
  const desktop = catalogue();
  expect(desktop.length).toBe(8);
  expect<unknown>(
    AI_PROVIDERS.map(({ id, name, summary, logins, mark }) => ({
      id,
      name,
      summary,
      logins,
      mark,
    })),
  ).toEqual(desktop);
});
