import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleCli,
  downloadNode,
  type Fetcher,
  nodeAsset,
  packCli,
  type Runner,
  resolveCliSource,
} from "./cli-bundle";

test("reads a dist-tag as an npm spec", () => {
  expect(resolveCliSource("latest")).toEqual({
    kind: "npm",
    spec: "copilotkit@latest",
  });
});

test("reads a prerelease version as an npm spec", () => {
  expect(resolveCliSource("4.34.0-rc.1")).toEqual({
    kind: "npm",
    spec: "copilotkit@4.34.0-rc.1",
  });
});

test("reads a pkg.pr.new link as a preview URL", () => {
  const url =
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@4dd2119";
  expect(resolveCliSource(url)).toEqual({ kind: "url", url });
});

test("refuses any other URL", () => {
  expect(() => resolveCliSource("http://example.com/x.tgz")).toThrow();
});

test("refuses an empty choice", () => {
  expect(() => resolveCliSource("")).toThrow();
  expect(() => resolveCliSource("   ")).toThrow();
});

test("points a Windows build at the bare node.exe", () => {
  const asset = nodeAsset("win32", "x64", "25.9.0");
  expect(asset.url.endsWith("/v25.9.0/win-x64/node.exe")).toBe(true);
  expect(asset.file).toBe("win-x64/node.exe");
  expect(asset.inArchive).toBe("");
});

test("points a macOS build at the tarball and the node binary inside it", () => {
  const asset = nodeAsset("darwin", "arm64", "25.9.0");
  expect(asset.url.endsWith("/v25.9.0/node-v25.9.0-darwin-arm64.tar.gz")).toBe(
    true,
  );
  expect(asset.inArchive).toBe("node-v25.9.0-darwin-arm64/bin/node");
});

test("refuses a Node version that is not exact", () => {
  expect(() => nodeAsset("darwin", "arm64", "25")).toThrow();
  expect(() => nodeAsset("darwin", "arm64", "v25.9.0")).toThrow();
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const noRun: Runner = () => ({ code: 0, stdout: "", stderr: "" });

function fakeFetch(files: Record<string, Uint8Array | string>): Fetcher {
  return async (url) => {
    const body = files[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
  };
}

test("downloads a win32 node.exe that matches SHASUMS256.txt", async () => {
  const asset = nodeAsset("win32", "x64", "25.9.0");
  const bytes = new TextEncoder().encode("fake node.exe");
  const dest = join(mkdtempSync(join(tmpdir(), "node-")), "bin", "node.exe");
  const result = await downloadNode(asset, "25.9.0", dest, {
    fetch: fakeFetch({
      "https://nodejs.org/dist/v25.9.0/SHASUMS256.txt": `${sha(bytes)}  ${asset.file}\n`,
      [asset.url]: bytes,
    }),
    run: noRun,
  });
  expect(result).toEqual({ version: "25.9.0", sha256: sha(bytes) });
  expect(readFileSync(dest)).toEqual(Buffer.from(bytes));
});

test("rejects a download whose hash differs from SHASUMS256.txt", async () => {
  const asset = nodeAsset("win32", "x64", "25.9.0");
  const bytes = new TextEncoder().encode("fake node.exe");
  const wrong = "0".repeat(64);
  const dest = join(mkdtempSync(join(tmpdir(), "node-")), "node.exe");
  await expect(
    downloadNode(asset, "25.9.0", dest, {
      fetch: fakeFetch({
        "https://nodejs.org/dist/v25.9.0/SHASUMS256.txt": `${wrong}  ${asset.file}\n`,
        [asset.url]: bytes,
      }),
      run: noRun,
    }),
  ).rejects.toThrow(new RegExp(`${wrong}[\\s\\S]*${sha(bytes)}`));
});

test("rejects when SHASUMS256.txt has no line for the file", async () => {
  const asset = nodeAsset("win32", "x64", "25.9.0");
  const dest = join(mkdtempSync(join(tmpdir(), "node-")), "node.exe");
  await expect(
    downloadNode(asset, "25.9.0", dest, {
      fetch: fakeFetch({
        "https://nodejs.org/dist/v25.9.0/SHASUMS256.txt": `${"a".repeat(64)}  other-file\n`,
        [asset.url]: "x",
      }),
      run: noRun,
    }),
  ).rejects.toThrow();
});

/**
 * A fake npm and tar. `npm pack` reports a tarball name, `tar` writes the
 * package folder the test describes, and every command is recorded.
 */
function fakePackRun(pkg: {
  name: string;
  version: string;
  bin: unknown;
  withIndex?: boolean;
}) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const run: Runner = (cmd, cwd) => {
    calls.push({ cmd, cwd });
    if (cmd[0] === "npm" && cmd[1] === "pack") {
      const out = JSON.stringify([
        { filename: `${pkg.name}-${pkg.version}.tgz`, integrity: "sha512-abc" },
      ]);
      return { code: 0, stdout: out, stderr: "" };
    }
    if (cmd[0] === "tar") {
      const dir = join(cmd[cmd.indexOf("-C") + 1], "package");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: pkg.name,
          version: pkg.version,
          bin: pkg.bin,
        }),
      );
      if (pkg.withIndex !== false) writeFileSync(join(dir, "index.js"), "");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function packDirs() {
  const root = mkdtempSync(join(tmpdir(), "pack-cli-"));
  return { workDir: join(root, "work"), cliDir: join(root, "cli") };
}

test("packs a preview and reports the package's own name and version", () => {
  const { workDir, cliDir } = packDirs();
  mkdirSync(workDir, { recursive: true });
  const { run, calls } = fakePackRun({
    name: "copilotkit-pr",
    version: "4.33.1-pr.4dd2119",
    bin: { copilotkit: "./index.js" },
  });
  const url =
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@4dd2119";
  const result = packCli({ kind: "url", url }, workDir, cliDir, run);
  expect(result).toEqual({
    source: url,
    name: "copilotkit-pr",
    version: "4.33.1-pr.4dd2119",
    integrity: "sha512-abc",
  });
  expect(calls[0].cmd).toEqual([
    "npm",
    "pack",
    url,
    "--json",
    "--pack-destination",
    workDir,
  ]);
  expect(existsSync(join(cliDir, "index.js"))).toBe(true);
});

test("installs production dependencies in the CLI folder", () => {
  const { workDir, cliDir } = packDirs();
  mkdirSync(workDir, { recursive: true });
  const { run, calls } = fakePackRun({
    name: "copilotkit",
    version: "4.34.0",
    bin: "index.js",
  });
  packCli({ kind: "npm", spec: "copilotkit@latest" }, workDir, cliDir, run);
  const install = calls[calls.length - 1];
  expect(install.cmd).toEqual([
    "npm",
    "install",
    "--omit=dev",
    "--ignore-scripts",
  ]);
  expect(install.cwd).toBe(cliDir);
});

test("refuses a package whose bin is not index.js", () => {
  const { workDir, cliDir } = packDirs();
  mkdirSync(workDir, { recursive: true });
  const { run } = fakePackRun({
    name: "copilotkit",
    version: "4.34.0",
    bin: { copilotkit: "bin/cli.js" },
  });
  expect(() =>
    packCli({ kind: "npm", spec: "copilotkit@latest" }, workDir, cliDir, run),
  ).toThrow("copilotkit@4.34.0 has no index.js bin");
});

test("refuses a package that lists index.js but does not ship it", () => {
  const { workDir, cliDir } = packDirs();
  mkdirSync(workDir, { recursive: true });
  const { run } = fakePackRun({
    name: "copilotkit",
    version: "4.34.0",
    bin: "index.js",
    withIndex: false,
  });
  expect(() =>
    packCli({ kind: "npm", spec: "copilotkit@latest" }, workDir, cliDir, run),
  ).toThrow("has no index.js bin");
});

test("throws with stderr when a command fails", () => {
  const { workDir, cliDir } = packDirs();
  const run: Runner = () => ({ code: 1, stdout: "", stderr: "E404 not found" });
  expect(() =>
    packCli({ kind: "npm", spec: "copilotkit@nope" }, workDir, cliDir, run),
  ).toThrow("E404 not found");
});

test("assembles Node and the CLI under the target and leaves no work folder", async () => {
  const asset = nodeAsset("win32", "x64", "25.9.0");
  const bytes = new TextEncoder().encode("fake node.exe");
  const target = join(mkdtempSync(join(tmpdir(), "bundle-")), "out");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "stale.txt"), "old");
  const { run } = fakePackRun({
    name: "copilotkit-pr",
    version: "4.33.1-pr.4dd2119",
    bin: "index.js",
  });
  const result = await bundleCli(target, "win32", "x64", {
    fetch: fakeFetch({
      "https://nodejs.org/dist/v25.9.0/SHASUMS256.txt": `${sha(bytes)}  ${asset.file}\n`,
      [asset.url]: bytes,
    }),
    run,
    choice: { cli: "latest", node: "25.9.0" },
  });
  expect(result).toEqual({
    cli: {
      source: "copilotkit@latest",
      name: "copilotkit-pr",
      version: "4.33.1-pr.4dd2119",
      integrity: "sha512-abc",
    },
    node: { version: "25.9.0", sha256: sha(bytes) },
  });
  expect(readFileSync(join(target, "runtime", "node.exe"))).toEqual(
    Buffer.from(bytes),
  );
  expect(existsSync(join(target, "cli", "index.js"))).toBe(true);
  expect(existsSync(join(target, "stale.txt"))).toBe(false);
  expect(readdirSync(target).sort()).toEqual(["cli", "runtime"]);
});

function runCommandLine(...args: string[]) {
  return Bun.spawnSync(
    ["bun", join(import.meta.dir, "cli-bundle.ts"), ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

test("the command line exits 1 on an unknown platform", () => {
  const result = runCommandLine("linux", "x64");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("linux");
});

test("the command line exits 1 on an unknown architecture", () => {
  const result = runCommandLine("darwin", "ia32");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("ia32");
});
