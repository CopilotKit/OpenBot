// Finds the newest release candidate tag on a commit. An rc beats a beta
// whatever the numbers are, and within one kind the highest number wins.
export function candidateAt(
  tagsAtCommit: string[],
  version: string,
): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^v${escaped}-(rc|beta)\\.([1-9]\\d*)$`);
  let best: { tag: string; rank: number; n: number } | null = null;
  for (const tag of tagsAtCommit) {
    const match = pattern.exec(tag);
    if (!match) continue;
    const rank = match[1] === "rc" ? 1 : 0;
    const n = Number(match[2]);
    if (!best || rank > best.rank || (rank === best.rank && n > best.n)) {
      best = { tag, rank, n };
    }
  }
  return best?.tag ?? null;
}

function withoutPackageVersion(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  delete parsed.version;
  return JSON.stringify(parsed);
}

function withoutAppVersion(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^appVersion:/.test(line))
    .join("\n");
}

// Drops the version line that sits directly under the desktop crate's name,
// so another crate's version still counts as a change.
function withoutDesktopVersion(text: string): string {
  const lines = text.split("\n");
  return lines
    .filter(
      (line, i) =>
        !(
          i > 0 &&
          lines[i - 1] === 'name = "openbot-desktop"' &&
          line.startsWith("version =")
        ),
    )
    .join("\n");
}

// The candidates and the final of one release share one policy, which names whichever of them it
// was last prepared for. Everything else in it, what the release upgrades from and how, must be
// what the candidate was tested with.
function withoutPolicyVersion(text: string): string {
  return withoutPackageVersion(text);
}

export const VERSION_ONLY_RULES: Record<string, (text: string) => string> = {
  "package.json": withoutPackageVersion,
  "release-policy.json": withoutPolicyVersion,
  "charts/openbot/Chart.yaml": withoutAppVersion,
  "desktop/src-tauri/Cargo.toml": withoutDesktopVersion,
  "desktop/src-tauri/Cargo.lock": withoutDesktopVersion,
};

// Checks the files that differ between a candidate and its final release.
// Only the version may move: the changelog may change freely, a few files may
// change their version and nothing else, and every other path is a violation.
// An empty result means the difference is allowed.
export function allowedDiff(
  files: Map<string, { before: string; after: string }>,
): string[] {
  const violations: string[] = [];
  for (const [path, { before, after }] of files) {
    if (path === "CHANGELOG.md") continue;
    const normalize = VERSION_ONLY_RULES[path];
    if (!normalize) {
      violations.push(
        `${path}: may not change between a candidate and its final release`,
      );
      continue;
    }
    if (normalize(before) !== normalize(after)) {
      violations.push(`${path}: changed beyond the version`);
    }
  }
  return violations;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

// Reads a file at a revision, or an empty string when it does not exist there.
function showFile(rev: string, path: string, cwd?: string): string {
  const result = Bun.spawnSync(["git", "show", `${rev}:${path}`], { cwd });
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

/**
 * Every path that differs between two commits, with what it held on each side, in the repository
 * at `cwd` (default the working directory). `--no-renames`, because with rename detection (git's
 * default) a file moved onto an allowed name, say `server/x.ts` renamed to `CHANGELOG.md`, is listed
 * under its new name alone, and the source file it removed would never be checked.
 */
export function changedFiles(
  before: string,
  after: string,
  cwd?: string,
): Map<string, { before: string; after: string }> {
  const diff = Bun.spawnSync(
    ["git", "diff", "--no-renames", "--name-only", "-z", before, after],
    { cwd },
  );
  if (diff.exitCode !== 0) {
    throw new Error(`git diff ${before} ${after}: ${diff.stderr.toString()}`);
  }
  const files = new Map<string, { before: string; after: string }>();
  for (const path of diff.stdout.toString().split("\0").filter(Boolean)) {
    files.set(path, {
      before: showFile(before, path, cwd),
      after: showFile(after, path, cwd),
    });
  }
  return files;
}

if (import.meta.main) {
  const [sha, version] = process.argv.slice(2);
  if (!sha || !version) {
    console.error(
      "Usage: bun scripts/release-candidate-check.ts <release-sha> <version>",
    );
    process.exit(1);
  }
  const parent = `${sha}^1`;
  const tags = git("tag", "--points-at", parent).split("\n").filter(Boolean);
  const candidate = candidateAt(tags, version);
  if (!candidate) {
    console.error(
      `The release's parent is not a candidate of ${version}. Cut a new candidate first.`,
    );
    process.exit(1);
  }
  const violations = allowedDiff(changedFiles(parent, sha));
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log(`v${version} matches ${candidate}`);
}
