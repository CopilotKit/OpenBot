import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRelease } from "./release-prepare";
import type { Kind } from "./release-version";

const directories: string[] = [];

const cargo = (version: string) =>
  `[package]\nname = "openbot-desktop"\nversion = "${version}"\n\n[dependencies]\nexample = "0.0.10"\n`;
const lock = (version: string) =>
  `version = 4\n\n[[package]]\nname = "example"\nversion = "0.0.10"\n\n[[package]]\nname = "openbot-desktop"\nversion = "${version}"\ndependencies = ["example"]\n`;

function fixture(version: string, unreleased = "- Something new.\n") {
  const root = mkdtempSync(join(tmpdir(), "openbot-release-prepare-"));
  directories.push(root);
  mkdirSync(join(root, "desktop/src-tauri"), { recursive: true });
  mkdirSync(join(root, "desktop/scripts"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "charts/openbot"), { recursive: true });
  const write = (path: string, text: string) =>
    writeFileSync(join(root, path), text);
  write("package.json", `${JSON.stringify({ version }, null, 2)}\n`);
  write(
    "CHANGELOG.md",
    `# Changelog\n\n## Unreleased\n\n${unreleased}\n## 0.1.0\n\n- First.\n`,
  );
  write("charts/openbot/Chart.yaml", 'name: openbot\nappVersion: "0.0.1"\n');
  write(
    "desktop/src-tauri/tauri.conf.json",
    '{"version":"../../package.json"}',
  );
  write("desktop/src-tauri/Cargo.toml", cargo(version));
  write("desktop/src-tauri/Cargo.lock", lock(version));
  copyFileSync(
    join(import.meta.dir, "../desktop/scripts/desktop-version.ts"),
    join(root, "desktop/scripts/desktop-version.ts"),
  );
  copyFileSync(
    join(import.meta.dir, "release-version.ts"),
    join(root, "scripts/release-version.ts"),
  );
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  return { root, read };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stable patch promotes the changelog and moves the chart and Cargo", () => {
  const { root, read } = fixture("0.2.0");
  const result = prepareRelease(root, "patch", "stable");
  expect(result.version).toBe("0.2.1");
  expect(result.base).toBe("main");
  expect(result.notes).toBe("- Something new.");
  expect(JSON.parse(read("package.json")).version).toBe("0.2.1");
  expect(read("CHANGELOG.md")).toContain(
    "## Unreleased\n\n## 0.2.1\n\n- Something new.",
  );
  expect(read("charts/openbot/Chart.yaml")).toContain('appVersion: "0.2.1"');
  expect(read("desktop/src-tauri/Cargo.toml")).toContain('version = "0.2.1"');
  expect(read("desktop/src-tauri/Cargo.lock")).toContain(
    'name = "openbot-desktop"\nversion = "0.2.1"',
  );
});

test("a minor release candidate leaves the changelog alone", () => {
  const { root, read } = fixture("0.2.0");
  const before = read("CHANGELOG.md");
  const result = prepareRelease(root, "minor", "rc");
  expect(result.version).toBe("0.3.0-rc.1");
  expect(result.base).toBe("release/0.3");
  expect(result.notes).toBe("- Something new.");
  expect(read("CHANGELOG.md")).toBe(before);
  expect(read("charts/openbot/Chart.yaml")).toContain(
    'appVersion: "0.3.0-rc.1"',
  );
});

test("final finishes a candidate under its own heading", () => {
  const { root, read } = fixture("0.3.0-rc.2");
  const result = prepareRelease(root, "patch", "final");
  expect(result.version).toBe("0.3.0");
  expect(result.base).toBe("release/0.3");
  expect(result.notes).toBe("- Something new.");
  expect(read("CHANGELOG.md")).toContain("## Unreleased\n\n## 0.3.0\n");
});

for (const kind of ["stable", "rc", "beta", "final"] as Kind[]) {
  test(`an empty Unreleased throws for ${kind}`, () => {
    const { root } = fixture(kind === "final" ? "0.3.0-rc.1" : "0.2.0", "\n");
    expect(() => prepareRelease(root, "patch", kind)).toThrow(
      "Nothing under '## Unreleased'",
    );
  });
}

test("a missing Unreleased heading throws", () => {
  const { root } = fixture("0.2.0");
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
  expect(() => prepareRelease(root, "patch", "stable")).toThrow(
    "no '## Unreleased' section",
  );
});

const cliPath = "desktop/intelligence-cli.json";

function withCli(version: string, cli: string) {
  const { root, read } = fixture(version);
  writeFileSync(
    join(root, cliPath),
    `${JSON.stringify({ cli, node: "25.9.0" }, null, 2)}\n`,
  );
  return { root, read };
}

test("a release candidate fixes a latest CLI to an exact version", () => {
  const { root, read } = withCli("0.1.0", "latest");
  const specs: string[] = [];
  prepareRelease(root, "minor", "rc", {
    npmView: (spec) => {
      specs.push(spec);
      return "4.33.1";
    },
  });
  expect(specs).toEqual(["copilotkit@latest"]);
  expect(JSON.parse(read(cliPath))).toEqual({ cli: "4.33.1", node: "25.9.0" });
  expect(read(cliPath)).toContain('"cli": "4.33.1"');
});

test("a release candidate with a fixed CLI leaves the file alone", () => {
  const { root, read } = withCli("0.1.0", "4.34.0-rc.1");
  const before = read(cliPath);
  prepareRelease(root, "minor", "rc", {
    npmView: () => {
      throw new Error("npmView must not be called");
    },
  });
  expect(read(cliPath)).toBe(before);
});

test("a release candidate fixes any dist-tag CLI to an exact version", () => {
  const { root, read } = withCli("0.1.0", "next");
  const specs: string[] = [];
  prepareRelease(root, "minor", "rc", {
    npmView: (spec) => {
      specs.push(spec);
      return "4.34.0-rc.2";
    },
  });
  expect(specs).toEqual(["copilotkit@next"]);
  expect(JSON.parse(read(cliPath))).toEqual({
    cli: "4.34.0-rc.2",
    node: "25.9.0",
  });
});

test("a release candidate leaves a pkg.pr.new CLI alone", () => {
  const { root, read } = withCli(
    "0.1.0",
    "https://pkg.pr.new/CopilotKit/CopilotKit/copilotkit@abc1234",
  );
  const before = read(cliPath);
  prepareRelease(root, "minor", "rc", {
    npmView: () => {
      throw new Error("npmView must not be called");
    },
  });
  expect(read(cliPath)).toBe(before);
});

test("a stable release never touches a latest CLI", () => {
  const { root, read } = withCli("0.1.0", "latest");
  const before = read(cliPath);
  prepareRelease(root, "patch", "stable", {
    npmView: () => {
      throw new Error("npmView must not be called");
    },
  });
  expect(read(cliPath)).toBe(before);
});

test("the CLI entry writes version, base and notes to GITHUB_OUTPUT", () => {
  const { root } = fixture("0.2.0");
  copyFileSync(
    join(import.meta.dir, "release-prepare.ts"),
    join(root, "scripts/release-prepare.ts"),
  );
  const output = join(root, "github-output.txt");
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(root, "scripts/release-prepare.ts"),
      "patch",
      "stable",
    ],
    { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output } },
  );
  expect(run.exitCode).toBe(0);
  const text = readFileSync(output, "utf8");
  expect(text).toContain("version=0.2.1\n");
  expect(text).toContain("base=main\n");
  expect(text).toMatch(/notes<<(EOF_[0-9a-f]+)\n- Something new\.\n\1\n/);
});
