import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Bump,
  type Kind,
  nextVersion,
  releaseBranch,
} from "./release-version";

export type Prepared = { version: string; base: string; notes: string };

// The lines of a "## " section, from the line after its heading to the next
// "## " heading.
function sectionBody(changelog: string, heading: string): string {
  const lines = changelog.split("\n");
  const body: string[] = [];
  let found = false;
  for (const line of lines) {
    if (line === heading) {
      found = true;
      continue;
    }
    if (line.startsWith("## ")) found = false;
    if (found) body.push(line);
  }
  return body.join("\n").trim();
}

export type PrepareOptions = { npmView?: (spec: string) => string };

// Asks npm for the version a spec resolves to.
function npmViewVersion(spec: string): string {
  const view = Bun.spawnSync(["npm", "view", spec, "version"]);
  if (view.exitCode !== 0) {
    throw new Error(`npm view ${spec} failed: ${view.stderr.toString()}`);
  }
  return view.stdout.toString().trim();
}

// Writes the version, the chart's appVersion, the Cargo files and the
// changelog for one release, and says what the release is called, which branch
// it is cut from, and what its notes say.
export function prepareRelease(
  root: string,
  bump: Bump,
  kind: Kind,
  options: PrepareOptions = {},
): Prepared {
  const packagePath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const version = nextVersion(pkg.version, bump, kind);

  // CHANGELOG.md is written by hand, for the person deciding whether to upgrade. This
  // promotes what is already there; it never generates notes from commit subjects, because a
  // commit subject is written for the person reading the diff.
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  if (!/^## Unreleased$/m.test(changelog)) {
    throw new Error("CHANGELOG.md has no '## Unreleased' section.");
  }
  const unreleased = sectionBody(changelog, "## Unreleased");
  if (unreleased === "") {
    throw new Error(
      "Nothing under '## Unreleased'. A release nobody can describe is not a release.",
    );
  }

  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const sync = Bun.spawnSync(
    [
      process.execPath,
      join(root, "desktop/scripts/desktop-version.ts"),
      "sync",
    ],
    { cwd: root },
  );
  if (sync.exitCode !== 0) {
    throw new Error(`desktop-version sync failed: ${sync.stderr.toString()}`);
  }

  // The chart's default image tag is its appVersion, so a release that moves package.json
  // without moving this leaves a default `helm install` pulling the previous image, or an
  // image tag that was never pushed. Move them together, every time.
  const chartPath = join(root, "charts/openbot/Chart.yaml");
  writeFileSync(
    chartPath,
    readFileSync(chartPath, "utf8").replace(
      /^appVersion:.*/m,
      `appVersion: "${version}"`,
    ),
  );

  carryReleasePolicy(root, version);

  // The final release must bundle the CLI its candidate bundled. A candidate or beta whose
  // CLI names an npm dist-tag ("latest", "next", "alpha") would let the final pick up a newer
  // one, so they fix the tag to the exact version now. An exact version, and a pkg.pr.new URL
  // (cli-bundle.ts builds only the form that names a commit), already cannot move. Stable and
  // final never touch the file.
  if (kind === "rc" || kind === "beta") {
    const cliPath = join(root, "desktop/intelligence-cli.json");
    if (existsSync(cliPath)) {
      const cliConfig = JSON.parse(readFileSync(cliPath, "utf8"));
      const current = cliConfig.cli;
      const immutable =
        typeof current !== "string" ||
        exactVersion.test(current) ||
        current.startsWith("https://pkg.pr.new/");
      if (!immutable) {
        const view = options.npmView ?? npmViewVersion;
        const cli = view(`copilotkit@${current}`);
        if (!exactVersion.test(cli)) {
          throw new Error(`copilotkit@${current} is not a version: '${cli}'.`);
        }
        // Only the `cli` string is replaced in the text, so the rest of the file, the pinned Node
        // version and its hashes, stays byte for byte as it was reviewed.
        const text = readFileSync(cliPath, "utf8");
        const updated = text.replace(
          /("cli"\s*:\s*)"(?:[^"\\]|\\.)*"/,
          (_, key: string) => key + JSON.stringify(cli),
        );
        const expected = JSON.stringify({ ...cliConfig, cli });
        if (JSON.stringify(JSON.parse(updated)) !== expected) {
          throw new Error(`Could not rewrite the cli field of ${cliPath}.`);
        }
        writeFileSync(cliPath, updated);
      }
    }
  }

  // Unreleased becomes the version, and a fresh empty Unreleased takes its place so the next
  // change has somewhere to go without anyone hand-editing a heading. A candidate or beta is
  // not the release itself, so it leaves the changelog for the final to promote.
  const promotes = kind === "stable" || kind === "final";
  let notes = unreleased;
  if (promotes) {
    const promoted = changelog.replace(
      /^## Unreleased$/m,
      `## Unreleased\n\n## ${version}`,
    );
    writeFileSync(changelogPath, promoted);
    notes = sectionBody(promoted, `## ${version}`);
  }

  return {
    version,
    base: kind === "stable" ? "main" : releaseBranch(version),
    notes,
  };
}

// release-policy.json is written by a person for one release: the versions it upgrades from, its
// database transition, downtime and recovery. Publish refuses a policy that does not name the
// version being released. The candidates, betas and final of one release share that policy, so
// within one release (v0.3.0, v0.3.0-rc.1, v0.3.0-rc.2, ...) only its `version` moves, and only
// that field is rewritten in the text. A policy written for another release is left as it is, so
// publishing still asks for this release's own.
export function carryReleasePolicy(root: string, version: string): boolean {
  const policyPath = join(root, "release-policy.json");
  if (!existsSync(policyPath)) return false;
  const text = readFileSync(policyPath, "utf8");
  const policy = JSON.parse(text);
  const current = policy.version;
  const next = `v${version}`;
  const release = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0];
  if (typeof current !== "string" || current === next) return false;
  if (release(current) !== release(next)) return false;
  const updated = text.replace(
    /("version"\s*:\s*)"(?:[^"\\]|\\.)*"/,
    (_, key: string) => key + JSON.stringify(next),
  );
  if (
    JSON.stringify(JSON.parse(updated)) !==
    JSON.stringify({ ...policy, version: next })
  ) {
    throw new Error(`Could not rewrite the version field of ${policyPath}.`);
  }
  writeFileSync(policyPath, updated);
  return true;
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const bumps: Bump[] = ["patch", "minor", "major"];
const kinds: Kind[] = ["stable", "rc", "beta", "final"];

// Runs from the release workflow: `bun scripts/release-prepare.ts <bump> <kind>`.
// The result goes to $GITHUB_OUTPUT so later steps can read it, or to stdout when
// run by hand. The notes go to a file and only its path is an output: a step that took them
// through an environment variable would fail once they pass 128 KB, the most Linux allows for
// one string.
if (import.meta.main) {
  const [bump, kind] = process.argv.slice(2);
  if (!bumps.includes(bump as Bump) || !kinds.includes(kind as Kind)) {
    console.error(
      `Usage: bun scripts/release-prepare.ts <${bumps.join("|")}> <${kinds.join("|")}>`,
    );
    process.exit(1);
  }
  try {
    const { version, base, notes } = prepareRelease(
      resolve(import.meta.dir, ".."),
      bump as Bump,
      kind as Kind,
    );
    const notesFile = join(
      process.env.RUNNER_TEMP || mkdtempSync(join(tmpdir(), "release-")),
      "release-notes.md",
    );
    writeFileSync(notesFile, notes);
    const text = `version=${version}\nbase=${base}\nnotes_file=${notesFile}\n`;
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, text);
    } else {
      process.stdout.write(text);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
