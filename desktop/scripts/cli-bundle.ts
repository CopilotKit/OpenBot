/** CI assembles the Intelligence CLI an installer bundles. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type CliSource =
  | { kind: "npm"; spec: string }
  | { kind: "url"; url: string };

const previewHost = "https://pkg.pr.new/";

/** Reads the CLI choice: an npm version or dist-tag, or a pkg.pr.new preview URL. */
export function resolveCliSource(cli: string): CliSource {
  const value = cli.trim();
  if (!value) throw new Error("The CLI choice is empty.");
  if (value.startsWith(previewHost)) return { kind: "url", url: value };
  if (value.includes("://") || value.startsWith("http")) {
    throw new Error(`Only ${previewHost} links are accepted, got "${value}".`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    throw new Error(`"${value}" is not an npm version or dist-tag.`);
  }
  return { kind: "npm", spec: `copilotkit@${value}` };
}

/**
 * Names the nodejs.org download for a platform and architecture. `file` is
 * the exact name SHASUMS256.txt lists; `inArchive` is where node sits inside
 * a tarball, or empty when the download is the binary itself.
 */
export function nodeAsset(
  platform: "darwin" | "win32",
  arch: "arm64" | "x64",
  node: string,
): { url: string; file: string; inArchive: string } {
  if (!/^\d+\.\d+\.\d+$/.test(node)) {
    throw new Error(`"${node}" is not an exact Node version like 25.9.0.`);
  }
  const base = `https://nodejs.org/dist/v${node}/`;
  if (platform === "win32") {
    const file = `win-${arch}/node.exe`;
    return { url: base + file, file, inArchive: "" };
  }
  const folder = `node-v${node}-darwin-${arch}`;
  const file = `${folder}.tar.gz`;
  return { url: base + file, file, inArchive: `${folder}/bin/node` };
}

export type Fetcher = (url: string) => Promise<Uint8Array>;
export type Runner = (
  cmd: string[],
  cwd: string,
) => { code: number; stdout: string; stderr: string };

/**
 * Downloads Node and checks it against the SHA-256 that nodejs.org publishes
 * in SHASUMS256.txt, then puts the binary at `dest`. A tarball is unpacked
 * first so only the node binary is copied.
 */
export async function downloadNode(
  asset: { url: string; file: string; inArchive: string },
  node: string,
  dest: string,
  deps: { fetch: Fetcher; run: Runner },
): Promise<{ version: string; sha256: string }> {
  const sums = new TextDecoder().decode(
    await deps.fetch(`https://nodejs.org/dist/v${node}/SHASUMS256.txt`),
  );
  let expected = "";
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === asset.file) expected = hash;
  }
  if (!expected) {
    throw new Error(`SHASUMS256.txt for Node ${node} has no ${asset.file}.`);
  }

  const bytes = await deps.fetch(asset.url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected) {
    throw new Error(
      `${asset.file} hash mismatch: expected ${expected}, got ${sha256}.`,
    );
  }

  mkdirSync(dirname(dest), { recursive: true });
  if (asset.inArchive) {
    const tmp = mkdtempSync(join(tmpdir(), "node-archive-"));
    try {
      const archive = join(tmp, "node.tar.gz");
      writeFileSync(archive, bytes);
      const result = deps.run(
        ["tar", "-xzf", archive, "-C", tmp, asset.inArchive],
        tmp,
      );
      if (result.code !== 0) {
        throw new Error(`tar failed: ${result.stderr}`);
      }
      copyFileSync(join(tmp, asset.inArchive), dest);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    writeFileSync(dest, bytes);
  }
  chmodSync(dest, 0o755);
  return { version: node, sha256 };
}

/** Runs a command and throws with its stderr when it exits non-zero. */
function runChecked(run: Runner, cmd: string[], cwd: string): string {
  const result = run(cmd, cwd);
  if (result.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Packs the CLI with npm, unpacks it into `cliDir`, and installs its
 * production dependencies there. Name and version come from the package's
 * own package.json, because previews are named `copilotkit-pr` and
 * `copilotkit-push`, not `copilotkit`. The package must ship index.js as its
 * bin, since that is the file the installer runs.
 */
export function packCli(
  source: CliSource,
  workDir: string,
  cliDir: string,
  run: Runner,
): { source: string; name: string; version: string; integrity: string } {
  const target = source.kind === "npm" ? source.spec : source.url;
  const packed = JSON.parse(
    runChecked(
      run,
      ["npm", "pack", target, "--json", "--pack-destination", workDir],
      workDir,
    ),
  );
  const { filename, integrity } = packed[0];

  runChecked(
    run,
    ["tar", "-xzf", join(workDir, filename), "-C", workDir],
    workDir,
  );
  const pkgDir = join(workDir, "package");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const { name, version } = pkg;

  const bins: unknown[] =
    typeof pkg.bin === "string"
      ? [pkg.bin]
      : pkg.bin && typeof pkg.bin === "object"
        ? Object.values(pkg.bin)
        : [];
  const hasIndexBin = bins.some(
    (bin) => typeof bin === "string" && bin.replace(/^\.\//, "") === "index.js",
  );
  if (!hasIndexBin || !existsSync(join(pkgDir, "index.js"))) {
    throw new Error(`${name}@${version} has no index.js bin`);
  }

  mkdirSync(dirname(cliDir), { recursive: true });
  renameSync(pkgDir, cliDir);
  runChecked(run, ["npm", "install", "--omit=dev", "--ignore-scripts"], cliDir);
  return { source: target, name, version, integrity };
}

/**
 * Assembles what an installer bundles under `target`: Node at
 * `runtime/node` (`node.exe` on Windows) and the CLI at `cli/`. `target` is
 * emptied first. The work folder lives inside `target`, not the system temp
 * dir, because packCli moves the package with a rename, which fails across
 * volumes. It is removed before this returns. `choice` defaults to
 * intelligence-cli.json next to the desktop folder's scripts.
 */
export async function bundleCli(
  target: string,
  platform: "darwin" | "win32",
  arch: "arm64" | "x64",
  deps: {
    fetch: Fetcher;
    run: Runner;
    choice?: { cli: string; node: string };
  },
): Promise<{
  cli: { source: string; name: string; version: string; integrity: string };
  node: { version: string; sha256: string };
}> {
  const choice =
    deps.choice ??
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "intelligence-cli.json"),
        "utf8",
      ),
    );
  rmSync(target, { recursive: true, force: true });
  const source = resolveCliSource(choice.cli);
  const asset = nodeAsset(platform, arch, choice.node);

  const nodeName = platform === "win32" ? "node.exe" : "node";
  const node = await downloadNode(
    asset,
    choice.node,
    join(target, "runtime", nodeName),
    deps,
  );

  const workDir = join(target, ".work");
  mkdirSync(workDir, { recursive: true });
  try {
    const cli = packCli(source, workDir, join(target, "cli"), deps.run);
    return { cli, node };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** The real fetch: global fetch, where a non-2xx answer is an error. */
const realFetch: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * The real runner. On Windows npm is a `.cmd` shim, so a bare `npm` does not
 * start there; the npm commands use `npm.cmd` instead. `tar` is left alone,
 * because Windows 10 and later ship bsdtar.
 */
const realRun: Runner = (cmd, cwd) => {
  const argv =
    process.platform === "win32" && cmd[0] === "npm"
      ? ["npm.cmd", ...cmd.slice(1)]
      : cmd;
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

async function main(platform?: string, arch?: string) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`Platform must be darwin or win32, got "${platform}".`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Architecture must be arm64 or x64, got "${arch}".`);
  }
  const desktop = join(import.meta.dir, "..");
  const result = await bundleCli(
    join(desktop, "src-tauri", "cli-bundle"),
    platform,
    arch,
    { fetch: realFetch, run: realRun },
  );

  const file = join(desktop, "build-version.json");
  const existing = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const merged = { ...existing, cli: result.cli, node: result.node };
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  writeFileSync(file, text);
  console.log(text.trim());
}

if (import.meta.main) {
  try {
    await main(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
