import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
// the containers run from, and the files the person's own browser runs from on the host.
const layout = () => constant("deployment.rs", "LAYOUT");
// The packages the browser's `shared` files import, put beside them from the browser's own install
// (stack.rs `SHARED_PACKAGES`).
const sharedPackages = () => constant("stack.rs", "SHARED_PACKAGES");
const BROWSER = "agent-computer";

// GitHub's tag tarball carries the tracked files. Lay out what Desktop keeps of them.
function trackedUnder(paths: string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...paths], {
    cwd: repositoryRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
}

function layOutDeployment(root: string): void {
  for (const file of trackedUnder(layout())) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repositoryRoot, file), join(root, file));
  }
}

function bun(args: string[], cwd: string): { exitCode: number; said: string } {
  const run = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: { ...process.env, COMPUTER_TOKEN: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, said: `${run.stdout}${run.stderr}` };
}

// Relative module specifiers a file loads at run time. `import type` and `import("./x").Type` name
// types, which Bun erases.
function runtimeRelativeImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*(import|export)(\s+type)?[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    if (!match[2]) found.push(match[3] ?? "");
  }
  for (const match of source.matchAll(
    /import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)(\.[A-Z])?/g,
  )) {
    if (!match[2]) found.push(match[1] ?? "");
  }
  return found;
}

describe("OpenBot Desktop's release tree", () => {
  test("lays out the Compose file and the person's browser, and nothing the containers run", () => {
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

  test("everything the person's browser loads is in the tree Desktop lays out", () => {
    const kept = new Set(trackedUnder(layout()));
    const pending = [...kept].filter(
      (file) => file.startsWith(`${BROWSER}/src/`) && file.endsWith(".ts"),
    );
    expect(pending).toContain(`${BROWSER}/src/index.ts`);
    const seen = new Set<string>();
    const missing: string[] = [];
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (seen.has(file) || file.includes("/tests/")) continue;
      seen.add(file);
      const source = readFileSync(join(repositoryRoot, file), "utf8");
      for (const specifier of runtimeRelativeImports(source)) {
        const base = join(dirname(file), specifier);
        const target = ["", ".ts", ".tsx", ".js", ".json", "/index.ts"]
          .map((suffix) => `${base}${suffix}`)
          .find((candidate) => kept.has(candidate));
        if (target) pending.push(target);
        else missing.push(`${file} imports ${specifier}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Laid out as Desktop lays it out, installed as Desktop installs it (stack::install_dependencies:
  // the browser's own frozen install, and its shared files' packages put beside them), and loaded
  // with Bun's auto-install off, so nothing missing is fetched behind the install's back.
  test("the person's browser installs and loads from that tree alone", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-desktop-tree-"));
    try {
      layOutDeployment(root);
      expect(existsSync(join(root, "package.json"))).toBe(false);
      const browser = join(root, BROWSER);
      expect(
        bun(["install", "--frozen-lockfile", "--ignore-scripts"], browser),
      ).toMatchObject({ exitCode: 0 });
      for (const name of sharedPackages()) {
        cpSync(
          join(browser, "node_modules", name),
          join(root, "shared", "node_modules", name),
          { recursive: true, dereference: true },
        );
      }

      for (const file of layout().filter(
        (path) => path.startsWith("shared/") && path.endsWith(".ts"),
      )) {
        const loaded = bun(
          [
            "--no-install",
            "--no-env-file",
            "-e",
            `await import(${JSON.stringify(`../${file}`)})`,
          ],
          browser,
        );
        expect({ file, ...loaded }).toEqual({ file, exitCode: 0, said: "" });
      }

      // Every import resolves; the computer then refuses to start without its token, which is the
      // first thing its own code does.
      const started = bun(
        ["--no-install", "--no-env-file", "src/index.ts"],
        browser,
      );
      expect(started.said).toContain("COMPUTER_TOKEN is not set");
      expect(started.said).not.toContain("Cannot find");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
