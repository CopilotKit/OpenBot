import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("keeps s6-overlay commands on PATH for platform lifecycle wrappers", () => {
  const dockerfile = readFileSync(
    join(import.meta.dir, "..", "Dockerfile"),
    "utf8",
  );

  // biome-ignore lint/suspicious/noTemplateCurlyInString: `${PATH}` must stay literal in Dockerfile.
  expect(dockerfile).toContain('ENV PATH="/command:/usr/local/bin:${PATH}"');
});
