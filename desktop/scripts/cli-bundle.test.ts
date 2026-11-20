import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  bundleCli,
  downloadNode,
  type Fetcher,
  type NodeChoice,
  nodeAsset,
  packCli,
  type Runner,
  realRun,
  resolveCliSource,
  shasumFor,
} from "./cli-bundle";

// Every temp folder a test makes, removed after each test.
const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("reads a commit-pinned pkg.pr.new link as a preview URL", () => {
  for (const url of [
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@4dd2119",
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-push@4dd2119",
    `https://pkg.pr.new/CopilotKit/Intelligence/copilotkit@${"a".repeat(40)}`,
  ]) {
    expect(resolveCliSource(url)).toEqual({ kind: "url", url });
  }
});

test("refuses a pkg.pr.new link that does not name one Intelligence commit", () => {
  for (const url of [
    // A PR number and a branch move with every push.
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@123",
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@main",
    "https://pkg.pr.new/SomeoneElse/Intelligence/copilotkit-pr@4dd2119",
    "https://pkg.pr.new/CopilotKit/Intelligence/left-pad@4dd2119",
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@4DD2119",
    "https://pkg.pr.new/CopilotKit/Intelligence/copilotkit-pr@4dd21",
  ]) {
    expect(() => resolveCliSource(url)).toThrow("copilotkit-pr@4dd2119");
  }
});

test("refuses any other URL", () => {
  expect(() => resolveCliSource("http://example.com/x.tgz")).toThrow();
});

test("refuses an empty choice", () => {
  expect(() => resolveCliSource("")).toThrow();
  expect(() => resolveCliSource("   ")).toThrow();
});

test("points a Windows build at the bare node.exe", () => {
  const asset = nodeAsset("win32", "x64", "26.13.0");
  expect(asset.url.endsWith("/v26.13.0/win-x64/node.exe")).toBe(true);
  expect(asset.file).toBe("win-x64/node.exe");
  expect(asset.inArchive).toBe("");
  expect(asset.key).toBe("win32-x64");
});

test("points a macOS build at the tarball and the node binary inside it", () => {
  const asset = nodeAsset("darwin", "arm64", "26.13.0");
  expect(
    asset.url.endsWith("/v26.13.0/node-v26.13.0-darwin-arm64.tar.gz"),
  ).toBe(true);
  expect(asset.inArchive).toBe("node-v26.13.0-darwin-arm64/bin/node");
});

test("refuses a Node version that is not exact", () => {
  expect(() => nodeAsset("darwin", "arm64", "26")).toThrow();
  expect(() => nodeAsset("darwin", "arm64", "v26.13.0")).toThrow();
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const noRun: Runner = () => ({ code: 0, stdout: "", stderr: "" });

// Lines from the real https://nodejs.org/dist/v26.13.0/SHASUMS256.txt, with
// the neighbours of the two files the installers use.
const realSums = `a9d7e34eaeeadd4ecbd9f0795f49f9d2c2625e63fc4e2f77709f039497f57033  node-v26.13.0-arm64.msi
d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6  node-v26.13.0-darwin-arm64.tar.gz
6f5b3187d9df9fc007e881167905bc7d69ad26450ddc377c83d63256a2495b6e  node-v26.13.0-darwin-arm64.tar.xz
525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e  node-v26.13.0-darwin-x64.tar.gz
4c9baa047c4ae555050179f25a63153f1c962af32e2aad97735fb550750c5e7a  win-arm64/node.exe
14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5  win-x64/node.exe
caad0090dc3add94c06abd01e395e8ec0f1586c10071bda1f99480445d695f6f  win-x64/node.lib
`;

test("finds the installers' files in a real SHASUMS256.txt", () => {
  const mac = nodeAsset("darwin", "arm64", "26.13.0");
  const win = nodeAsset("win32", "x64", "26.13.0");
  expect(shasumFor(realSums, mac.file)).toBe(
    "d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6",
  );
  expect(shasumFor(realSums, win.file)).toBe(
    "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5",
  );
  expect(shasumFor(realSums, "node-v26.13.0-darwin-arm64")).toBe("");
});

test("intelligence-cli.json pins the hashes nodejs.org lists", () => {
  const choice = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "intelligence-cli.json"), "utf8"),
  );
  expect(choice.node.version).toBe("26.13.0");
  // Every installer that bundles the CLI: desktop-build.yml's Apple silicon and Windows ones, and
  // the signed Intel Mac one Desktop macOS signing builds.
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ] as const) {
    const asset = nodeAsset(platform, arch, choice.node.version);
    expect(choice.node.sha256[asset.key]).toBe(shasumFor(realSums, asset.file));
  }
});

/** A Node choice whose pinned hash for `key` is `hash`. */
function pin(key: string, hash: string): NodeChoice {
  return { version: "26.13.0", sha256: { [key]: hash } };
}

const sumsUrl = "https://nodejs.org/dist/v26.13.0/SHASUMS256.txt";

function fakeFetch(files: Record<string, Uint8Array | string>): Fetcher {
  return async (url) => {
    const body = files[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
  };
}

test("downloads a win32 node.exe that matches SHASUMS256.txt", async () => {
  const asset = nodeAsset("win32", "x64", "26.13.0");
  const bytes = new TextEncoder().encode("fake node.exe");
  const dest = join(tempDir("node-"), "bin", "node.exe");
  const result = await downloadNode(asset, pin(asset.key, sha(bytes)), dest, {
    fetch: fakeFetch({
      [sumsUrl]: `${sha(bytes)}  ${asset.file}\n`,
      [asset.url]: bytes,
    }),
    run: noRun,
  });
  expect(result).toEqual({ version: "26.13.0", sha256: sha(bytes) });
  expect(readFileSync(dest)).toEqual(Buffer.from(bytes));
});

test("rejects a download whose hash differs from the pin and SHASUMS256.txt", async () => {
  const asset = nodeAsset("win32", "x64", "26.13.0");
  const bytes = new TextEncoder().encode("fake node.exe");
  const wrong = "0".repeat(64);
  const dest = join(tempDir("node-"), "node.exe");
  await expect(
    downloadNode(asset, pin(asset.key, wrong), dest, {
      fetch: fakeFetch({
        [sumsUrl]: `${wrong}  ${asset.file}\n`,
        [asset.url]: bytes,
      }),
      run: noRun,
    }),
  ).rejects.toThrow(new RegExp(`${wrong}[\\s\\S]*${sha(bytes)}`));
  expect(existsSync(dest)).toBe(false);
});

test("rejects a nodejs.org that serves another binary with a matching SHASUMS256.txt", async () => {
  const asset = nodeAsset("win32", "x64", "26.13.0");
  const swapped = new TextEncoder().encode("not the reviewed node.exe");
  const pinned =
    "14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5";
  const dest = join(tempDir("node-"), "node.exe");
  await expect(
    downloadNode(asset, pin(asset.key, pinned), dest, {
      fetch: fakeFetch({
        [sumsUrl]: `${sha(swapped)}  ${asset.file}\n`,
        [asset.url]: swapped,
      }),
      run: noRun,
    }),
  ).rejects.toThrow(`intelligence-cli.json pins ${pinned}`);
  expect(existsSync(dest)).toBe(false);
});

test("refuses a platform that has no pinned hash, before downloading", async () => {
  const asset = nodeAsset("win32", "x64", "26.13.0");
  const dest = join(tempDir("node-"), "node.exe");
  for (const node of [
    pin("darwin-arm64", "a".repeat(64)),
    pin(asset.key, ""),
    pin(asset.key, "not a hash"),
  ]) {
    await expect(
      downloadNode(asset, node, dest, { fetch: fakeFetch({}), run: noRun }),
    ).rejects.toThrow("pins no SHA-256 for Node 26.13.0 on win32-x64");
  }
});

test("rejects when SHASUMS256.txt has no line for the file", async () => {
  const asset = nodeAsset("win32", "x64", "26.13.0");
  const dest = join(tempDir("node-"), "node.exe");
  await expect(
    downloadNode(asset, pin(asset.key, "a".repeat(64)), dest, {
      fetch: fakeFetch({
        [sumsUrl]: `${"a".repeat(64)}  other-file\n`,
        [asset.url]: "x",
      }),
      run: noRun,
    }),
  ).rejects.toThrow("has no win-x64/node.exe");
});

test("unpacks node from a real darwin tarball with the real tar", async () => {
  const asset = nodeAsset("darwin", "arm64", "26.13.0");
  const build = tempDir("node-tarball-");
  const binDir = join(build, "node-v26.13.0-darwin-arm64", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "node"), "#!/bin/sh\necho fake node\n");
  writeFileSync(join(build, "node-v26.13.0-darwin-arm64", "README.md"), "");
  const made = realRun(
    ["tar", "-czf", asset.file, "node-v26.13.0-darwin-arm64"],
    build,
  );
  expect(made.code).toBe(0);
  const bytes = new Uint8Array(readFileSync(join(build, asset.file)));

  const dest = join(tempDir("node-dest-"), "runtime", "node");
  const result = await downloadNode(asset, pin(asset.key, sha(bytes)), dest, {
    fetch: fakeFetch({
      [sumsUrl]: `${"b".repeat(64)}  node-v26.13.0-darwin-x64.tar.gz\n${sha(bytes)}  ${asset.file}\n`,
      [asset.url]: bytes,
    }),
    run: realRun,
  });
  expect(result).toEqual({ version: "26.13.0", sha256: sha(bytes) });
  expect(readFileSync(dest, "utf8")).toBe("#!/bin/sh\necho fake node\n");
  expect(statSync(dest).mode & 0o777).toBe(0o755);
  expect(readdirSync(join(dest, ".."))).toEqual(["node"]);
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
  withLockfile?: boolean;
}) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const run: Runner = (cmd, cwd) => {
    calls.push({ cmd, cwd });
    if (cmd[0] === "npm" && cmd[1] === "install") {
      if (pkg.withLockfile === false) {
        return { code: 0, stdout: "", stderr: "" };
      }
      // Two packages on disk, one dev package npm left out.
      for (const dep of ["node_modules/a", "node_modules/a/node_modules/b"]) {
        mkdirSync(join(cwd, dep), { recursive: true });
      }
      writeFileSync(join(cwd, "package-lock.json"), fixtureLock);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "npm" && cmd[1] === "pack") {
      const out = JSON.stringify([
        { filename: `${pkg.name}-${pkg.version}.tgz`, integrity: "sha512-abc" },
      ]);
      return { code: 0, stdout: out, stderr: "" };
    }
    if (cmd[0] === "tar") {
      const dir = join(resolve(cwd, cmd[cmd.indexOf("-C") + 1]), "package");
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

const fixtureLock = `${JSON.stringify(
  {
    name: "copilotkit",
    lockfileVersion: 3,
    packages: {
      "": { name: "copilotkit" },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
      "node_modules/dev-only": { version: "3.0.0", dev: true },
    },
  },
  null,
  2,
)}\n`;
const fixtureLockSha = sha(new TextEncoder().encode(fixtureLock));

function packDirs() {
  const root = tempDir("pack-cli-");
  return { workDir: join(root, "work"), cliDir: join(root, "cli") };
}

/**
 * Windows: the build step runs in Git's bash, whose GNU tar reads `D:\\a\\...\\copilotkit.tgz` as the
 * host `D` and fails ("Cannot connect to D: resolve failed"). The tarball is named relative to the
 * work folder it is unpacked in, which every tar reads as a file.
 */
test("unpacks the CLI by paths relative to its work folder", () => {
  const { workDir, cliDir } = packDirs();
  mkdirSync(workDir, { recursive: true });
  const { run, calls } = fakePackRun({
    name: "copilotkit",
    version: "4.33.1",
    bin: { copilotkit: "index.js" },
  });
  packCli({ kind: "npm", spec: "copilotkit@latest" }, workDir, cliDir, run);
  const tar = calls.find((call) => call.cmd[0] === "tar");
  expect(tar?.cmd).toEqual(["tar", "-xzf", "copilotkit-4.33.1.tgz", "-C", "."]);
  expect(tar?.cwd).toBe(workDir);
});

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
    lockfileSha256: fixtureLockSha,
    dependencies: 2,
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
  expect(readFileSync(join(cliDir, "package-lock.json"), "utf8")).toBe(
    fixtureLock,
  );
});

test("refuses a CLI when npm wrote no lockfile", () => {
  const { workDir, cliDir } = packDirs();
  mkdirSync(workDir, { recursive: true });
  const { run } = fakePackRun({
    name: "copilotkit",
    version: "4.34.0",
    bin: "index.js",
    withLockfile: false,
  });
  expect(() =>
    packCli({ kind: "npm", spec: "copilotkit@latest" }, workDir, cliDir, run),
  ).toThrow("wrote no package-lock.json");
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
  const asset = nodeAsset("win32", "x64", "26.13.0");
  const bytes = new TextEncoder().encode("fake node.exe");
  const target = join(tempDir("bundle-"), "out");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "stale.txt"), "old");
  const { run } = fakePackRun({
    name: "copilotkit-pr",
    version: "4.33.1-pr.4dd2119",
    bin: "index.js",
  });
  const result = await bundleCli(target, "win32", "x64", {
    fetch: fakeFetch({
      [sumsUrl]: `${sha(bytes)}  ${asset.file}\n`,
      [asset.url]: bytes,
    }),
    run,
    choice: { cli: "latest", node: pin(asset.key, sha(bytes)) },
  });
  expect(result).toEqual({
    cli: {
      source: "copilotkit@latest",
      name: "copilotkit-pr",
      version: "4.33.1-pr.4dd2119",
      integrity: "sha512-abc",
      lockfileSha256: fixtureLockSha,
      dependencies: 2,
    },
    node: { version: "26.13.0", sha256: sha(bytes) },
  });
  expect(readFileSync(join(target, "runtime", "node.exe"))).toEqual(
    Buffer.from(bytes),
  );
  expect(existsSync(join(target, "cli", "index.js"))).toBe(true);
  expect(existsSync(join(target, "stale.txt"))).toBe(false);
  expect(readdirSync(target).sort()).toEqual(["cli", "runtime"]);
});

// The Intel Mac installer is built on an Apple silicon runner. npm picks a dependency's
// platform-specific packages for the machine it runs on unless told otherwise, which would put
// Apple silicon binaries in the Intel app.
test("installs the CLI's dependencies for the installer's platform, not the runner's", async () => {
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ] as const) {
    const asset = nodeAsset(platform, arch, "26.13.0");
    const bytes = new TextEncoder().encode(`fake node ${platform}-${arch}`);
    const target = join(tempDir("bundle-"), "out");
    const { run, calls } = fakePackRun({
      name: "copilotkit",
      version: "4.34.0",
      bin: "index.js",
    });
    await bundleCli(target, platform, arch, {
      fetch: fakeFetch({
        [sumsUrl]: `${sha(bytes)}  ${asset.file}\n`,
        [asset.url]: bytes,
      }),
      // tar unpacks the Node archive; the fake leaves the binary where tar would.
      run: (cmd, cwd) => {
        if (
          cmd[0] === "tar" &&
          asset.inArchive &&
          cmd.includes(asset.inArchive)
        ) {
          const dest = join(cwd, asset.inArchive);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, bytes);
          return { code: 0, stdout: "", stderr: "" };
        }
        return run(cmd, cwd);
      },
      choice: { cli: "latest", node: pin(asset.key, sha(bytes)) },
    });
    const install = calls.find(
      (call) => call.cmd[0] === "npm" && call.cmd[1] === "install",
    );
    expect(install?.cmd).toEqual([
      "npm",
      "install",
      "--omit=dev",
      "--ignore-scripts",
      `--os=${platform}`,
      `--cpu=${arch}`,
    ]);
  }
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
