import { expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { DOESNT_UPDATE_ITSELF } from "./desktop-updates";

const ROOT = join(import.meta.dir, "..");

test("a build that doesn't update itself says what happened and what to do", () => {
  expect(DOESNT_UPDATE_ITSELF).toBe(
    "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.",
  );
});

/**
 * The setup window and Settings › This computer said this in two spellings once, one of them
 * without "of OpenBot". Each now reads the shared sentence, so neither may write its own.
 */
test("the setup window and Settings say it only through the shared sentence", async () => {
  const spelled: string[] = [];
  for (const dir of ["app/src", "desktop/src"]) {
    for await (const file of new Glob("**/*.{ts,tsx}").scan(join(ROOT, dir))) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = await Bun.file(join(ROOT, dir, file)).text();
      // JSX wraps long text across lines, so the words are compared with the whitespace folded.
      if (
        /This\s+version\s+of\s+OpenBot\s+doesn't\s+update\s+itself/.test(text)
      )
        spelled.push(`${dir}/${file}`);
    }
  }
  expect(spelled).toEqual([]);
});
