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

/**
 * A preview pinned to one commit. pkg.pr.new also serves `@<pr-number>` and
 * `@<branch>`, but those move with every push, so two builds of the same
 * choice could bundle different code.
 */
const previewUrl =
  /^https:\/\/pkg\.pr\.new\/CopilotKit\/Intelligence\/(?:copilotkit|copilotkit-pr|copilotkit-push)@[0-9a-f]{7,40}$/;

/**
 * Reads the CLI choice: an npm version or dist-tag, or a pkg.pr.new preview
 * URL of an Intelligence commit.
 */
export function resolveCliSource(cli: string): CliSource {
  const value = cli.trim();
  if (!value) throw new Error("The CLI choice is empty.");
  if (previewUrl.test(value)) return { kind: "url", url: value };
  if (value.startsWith(previewHost)) {
    throw new Error(
      `"${value}" is not a preview of one Intelligence commit. Use the commit form, such as ${previewHost}CopilotKit/Intelligence/copilotkit-pr@4dd2119.`,
    );
  }
  if (value.includes("://") || value.startsWith("http")) {
    throw new Error(`Only ${previewHost} links are accepted, got "${value}".`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    throw new Error(`"${value}" is not an npm version or dist-tag.`);
  }
  return { kind: "npm", spec: `copilotkit@${value}` };
}

export type Platform = "darwin" | "win32";
export type Arch = "arm64" | "x64";

/**
 * The Node an installer bundles: an exact version, and the SHA-256 of its
 * download for each platform, keyed like `darwin-arm64`.
 */
export type NodeChoice = { version: string; sha256: Record<string, string> };

export type CliChoice = { cli: string; node: NodeChoice };

export type NodeAsset = {
  url: string;
  file: string;
  inArchive: string;
  key: string;
};

/**
 * Names the nodejs.org download for a platform and architecture. `file` is
 * the exact name SHASUMS256.txt lists; `inArchive` is where node sits inside
 * a tarball, or empty when the download is the binary itself. `key` names
 * the download's pinned hash in intelligence-cli.json.
 */
export function nodeAsset(
  platform: Platform,
  arch: Arch,
  node: string,
): NodeAsset {
  if (!/^\d+\.\d+\.\d+$/.test(node)) {
    throw new Error(`"${node}" is not an exact Node version like 26.13.0.`);
  }
  const base = `https://nodejs.org/dist/v${node}/`;
  const key = `${platform}-${arch}`;
  if (platform === "win32") {
    const file = `win-${arch}/node.exe`;
    return { url: base + file, file, inArchive: "", key };
  }
  const folder = `node-v${node}-darwin-${arch}`;
  const file = `${folder}.tar.gz`;
  return { url: base + file, file, inArchive: `${folder}/bin/node`, key };
}

/**
 * Finds a file's hash in SHASUMS256.txt, where each line is a hash, two
 * spaces and the file name. Returns "" when the file is not listed.
 */
export function shasumFor(sums: string, file: string): string {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === file) return hash;
  }
  return "";
}

export type Fetcher = (url: string) => Promise<Uint8Array>;
export type Runner = (
  cmd: string[],
  cwd: string,
) => { code: number; stdout: string; stderr: string };

/**
 * Downloads Node, checks it, and puts the binary at `dest`. The download must
 * match both the SHA-256 pinned in intelligence-cli.json and the one
 * nodejs.org lists in SHASUMS256.txt. The pin is reviewed in this repository,
 * so a nodejs.org that serves a different binary with a matching
 * SHASUMS256.txt is still refused. A tarball is unpacked first so only the
 * node binary is copied.
 */
export async function downloadNode(
  asset: NodeAsset,
  node: NodeChoice,
  dest: string,
  deps: { fetch: Fetcher; run: Runner },
): Promise<{ version: string; sha256: string }> {
  const pinned = node.sha256?.[asset.key] ?? "";
  if (!/^[0-9a-f]{64}$/.test(pinned)) {
    throw new Error(
      `intelligence-cli.json pins no SHA-256 for Node ${node.version} on ${asset.key}. Copy the ${asset.file} line from that release's SHASUMS256.txt.`,
    );
  }

  const sums = new TextDecoder().decode(
    await deps.fetch(`https://nodejs.org/dist/v${node.version}/SHASUMS256.txt`),
  );
  const listed = shasumFor(sums, asset.file);
  if (!listed) {
    throw new Error(
      `SHASUMS256.txt for Node ${node.version} has no ${asset.file}.`,
    );
  }
  if (listed !== pinned) {
    throw new Error(
      `${asset.file}: SHASUMS256.txt lists ${listed}, but intelligence-cli.json pins ${pinned}.`,
    );
  }

  const bytes = await deps.fetch(asset.url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pinned) {
    throw new Error(
      `${asset.file} hash mismatch: expected ${pinned}, got ${sha256}.`,
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
  return { version: node.version, sha256 };
}

/** Runs a command and throws with its stderr when it exits non-zero. */
function runChecked(run: Runner, cmd: string[], cwd: string): string {
  const result = run(cmd, cwd);
  if (result.code !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** What the build records about the CLI it bundled. */
export type CliRecord = {
  source: string;
  name: string;
  version: string;
  integrity: string;
  lockfileSha256: string;
  dependencies: number;
};

/**
 * Packs the CLI with npm, unpacks it into `cliDir`, and installs its
 * production dependencies there. Name and version come from the package's
 * own package.json, because previews are named `copilotkit-pr` and
 * `copilotkit-push`, not `copilotkit`. The package must ship index.js as its
 * bin, since that is the file the installer runs.
 *
 * The CLI ships no lockfile, so npm picks its dependencies at build time.
 * The lockfile npm writes stays in `cliDir`, and its SHA-256 and the number
 * of packages it installed are returned, so two builds of the same choice
 * can be compared. npm writes npm-shrinkwrap.json instead when the package
 * ships one.
 *
 * `installFor` is the platform the installer is for. npm otherwise picks a
 * dependency's platform-specific optional packages for the machine it runs
 * on, so the Intel Mac installer, built on an Apple silicon runner, would
 * carry Apple silicon binaries. `--os` and `--cpu` make npm pick them for
 * the installer's platform instead; for a build on its own platform they
 * change nothing.
 */
export function packCli(
  source: CliSource,
  workDir: string,
  cliDir: string,
  run: Runner,
  installFor?: { platform: Platform; arch: Arch },
): CliRecord {
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
    // Relative to the work folder: Git's GNU tar, which a bash step on Windows runs, reads
    // `D:\...` as a remote host.
    ["tar", "-xzf", filename, "-C", "."],
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
  runChecked(
    run,
    [
      "npm",
      "install",
      "--omit=dev",
      "--ignore-scripts",
      ...(installFor
        ? [`--os=${installFor.platform}`, `--cpu=${installFor.arch}`]
        : []),
    ],
    cliDir,
  );
  const lockfile = ["npm-shrinkwrap.json", "package-lock.json"]
    .map((file) => join(cliDir, file))
    .find((file) => existsSync(file));
  if (!lockfile) {
    throw new Error(`npm install wrote no package-lock.json for ${name}.`);
  }
  const lockText = readFileSync(lockfile);
  const lockfileSha256 = createHash("sha256").update(lockText).digest("hex");
  return {
    source: target,
    name,
    version,
    integrity,
    lockfileSha256,
    dependencies: installedPackages(JSON.parse(lockText.toString()), cliDir),
  };
}

/**
 * Counts the packages a lockfile lists that npm put on disk. Dev and
 * other-platform optional packages are listed but not installed, so they are
 * left out. The root entry "" is the CLI itself.
 */
function installedPackages(
  lock: { packages?: Record<string, unknown> },
  cliDir: string,
): number {
  if (!lock.packages) {
    throw new Error("The CLI's lockfile has no packages list.");
  }
  return Object.keys(lock.packages).filter(
    (path) => path !== "" && existsSync(join(cliDir, path)),
  ).length;
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
  platform: Platform,
  arch: Arch,
  deps: {
    fetch: Fetcher;
    run: Runner;
    choice?: CliChoice;
  },
): Promise<{
  cli: CliRecord;
  node: { version: string; sha256: string };
}> {
  const choice: CliChoice =
    deps.choice ??
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "intelligence-cli.json"),
        "utf8",
      ),
    );
  rmSync(target, { recursive: true, force: true });
  const source = resolveCliSource(choice.cli);
  const asset = nodeAsset(platform, arch, choice.node.version);

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
    const cli = packCli(source, workDir, join(target, "cli"), deps.run, {
      platform,
      arch,
    });
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
export const realRun: Runner = (cmd, cwd) => {
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
