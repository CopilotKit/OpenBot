import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BunPlugin } from "bun";

/**
 * `@/lib/marks` for a screen a test bundles with `Bun.build` and loads in a real browser.
 *
 * The app reads the vendored marks with Vite's `import.meta.glob`, which `Bun.build` doesn't know:
 * a bundle that reaches a brand mark (a model's maker in a list of models, say) would stop on it.
 * This hands the same files over the same way, as data URIs keyed by brand id.
 */
export const marksPlugin: BunPlugin = {
  name: "marks",
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
      path: "marks",
      namespace: "marks",
    }));
    build.onLoad({ filter: /.*/, namespace: "marks" }, () => {
      const dir = join(import.meta.dir, "..", "..", "shared", "marks");
      const marks = Object.fromEntries(
        readdirSync(dir)
          .filter((file) => file.endsWith(".svg"))
          .map((file) => [
            file.replace(".svg", ""),
            `data:image/svg+xml;base64,${readFileSync(join(dir, file)).toString("base64")}`,
          ]),
      );
      return {
        contents: `const marks = ${JSON.stringify(marks)}; export const markFor = (id) => (id && marks[id]) || null;`,
        loader: "js",
      };
    });
  },
};
