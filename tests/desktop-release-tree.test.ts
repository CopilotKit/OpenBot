import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const tauriSource = join(repositoryRoot, "desktop", "src-tauri", "src");

// The string literals of one `pub const NAME: [&str; N] = [...]` in a desktop source file, with
// comments taken out first.
function constant(file: string, name: string): string[] {
  const source = readFileSync(join(tauriSource, file), "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const block = source.match(
    new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`),
  );
  expect({ file, name, found: block !== null }).toEqual({
    file,
    name,
    found: true,
  });
  return [...(block?.[1] ?? "").matchAll(/"([^"]*)"/g)].map(
    (match) => match[1] ?? "",
  );
}

// What OpenBot Desktop keeps of a release's tag tarball (deployment.rs `LAYOUT`): the Compose file
// the containers run from. Every container, the computer and the person's browser on it included,
// runs from the release's images.
const layout = () => constant("deployment.rs", "LAYOUT");

// GitHub's tag tarball carries the tracked files. Lay out what Desktop keeps of them.
function trackedUnder(paths: string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...paths], {
    cwd: repositoryRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
}

describe("OpenBot Desktop's release tree", () => {
  test("lays out the Compose file, and nothing the containers run", () => {
    const paths = layout();
    expect(paths).toContain("docker-compose.yml");
    for (const path of paths) {
      // A path the tag tarball does not carry is a deployment Desktop cannot lay out.
      expect({ path, tracked: trackedUnder([path]).length > 0 }).toEqual({
        path,
        tracked: true,
      });
      for (const container of [
        "server",
        "app",
        "worker",
        "toolkit",
        "examples",
        "scripts",
        "patches",
      ]) {
        expect({ path, inside: path.startsWith(`${container}/`) }).toEqual({
          path,
          inside: false,
        });
      }
    }
  });

  // Earlier versions ran a browser of the person's own on the desktop, from `agent-computer` and
  // the `shared` files it imports. The person's browser is on the one computer now, shown in the
  // OpenBot window, so nothing of it is laid out on the host.
  test("lays out no browser to run on the person's desktop", () => {
    expect(
      trackedUnder(layout()).filter(
        (file) =>
          file.startsWith("agent-computer/") || file.startsWith("shared/"),
      ),
    ).toEqual([]);
  });
});
