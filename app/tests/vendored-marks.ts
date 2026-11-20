import { readdirSync } from "node:fs";

/**
 * `markFor` as the app resolves it, for tests that care which brands have a mark.
 *
 * The real module globs `shared/marks/*.svg` through Vite, which `bun test` does not have, so the
 * preload stubs it to null for everybody. This reads the same directory instead, so a brand has a
 * mark here exactly when a file for it is vendored, and a row that should draw none is caught
 * drawing one. Register it with `mock.module("@/lib/marks", ...)` before importing what renders.
 */
const vendored = new Set(
  readdirSync(new URL("../../shared/marks/", import.meta.url))
    .filter((file) => file.endsWith(".svg"))
    .map((file) => file.slice(0, -".svg".length)),
);

export function vendoredMarkFor(id: string | null | undefined): string | null {
  return id && vendored.has(id) ? `data:image/svg+xml,${id}` : null;
}
