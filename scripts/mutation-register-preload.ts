// Applies ONE mutation-register entry to a module's source as bun imports it. See
// `scripts/mutation-register.ts`, which spawns `bun test --preload` with this file.
//
// IN MEMORY, NEVER ON DISK. The loader hands bun the rewritten source; the file itself is never
// opened for writing, so a crashed, timed-out or interrupted run leaves the tree exactly as it was.
//
// The mark file is how the runner tells "the suite caught the mutation" apart from "the suite never
// imported the mutated file": it is written only when the rewrite actually happened.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";
import { mutate, REGISTER, REPO_ROOT } from "./mutation-register";

const id = process.env.MUTATION_REGISTER_ENTRY;
const mark = process.env.MUTATION_REGISTER_MARK;
const entry = REGISTER.find((e) => e.id === id);
if (!entry || !mark) {
  throw new Error(
    `mutation-register-preload: no register entry named ${JSON.stringify(id)}, or no mark path. Run it through scripts/mutation-register.ts.`,
  );
}
const target = join(REPO_ROOT, entry.path);
const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

plugin({
  name: `mutation-register:${entry.id}`,
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => {
      const contents = mutate(readFileSync(args.path, "utf8"), entry);
      writeFileSync(mark, entry.id);
      return { contents, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  },
});
