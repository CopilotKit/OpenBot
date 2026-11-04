import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { integrateUpstream } from "../scripts/integrate-upstream";
import {
  createReleaseArtifacts,
  readReleaseConfiguration,
  readReleasePolicy,
} from "../scripts/release-manifest";
import { parseReleaseManifest } from "../shared/release-manifest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "openbot-upstream-"));
  directories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Upgrade Test");
  git(root, "config", "user.email", "upgrade@example.test");
  writeFileSync(join(root, "core.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  const baseline = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-c", "upstream");
  writeFileSync(join(root, "core.txt"), "upstream\n");
  git(root, "commit", "-am", "upstream release");
  git(root, "tag", "v0.3.0");
  const upstream = git(root, "rev-parse", "HEAD");
  git(root, "switch", "main");
  writeFileSync(join(root, "customer.txt"), "customer component\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "customer extension");
  return { root, baseline, upstream, output: `${root}-candidate` };
}
function integrateOptions(repo: ReturnType<typeof repository>) {
  directories.push(repo.output);
  return {
    repositoryRoot: repo.root,
    outputDirectory: repo.output,
    branch: "upgrade/upstream-v0.3.0",
    baselineCommit: repo.baseline,
    upstreamRepository: repo.root,
    upstreamRef: "refs/tags/v0.3.0",
    upstreamCommit: repo.upstream,
    checks: [
      [
        process.execPath,
        "-e",
        "if (!require('fs').readFileSync('customer.txt','utf8').includes('customer component')) process.exit(1)",
      ],
    ],
  };
}

describe("isolated upstream integration", () => {
  test("a regression command cannot silently change the candidate after verification", async () => {
    const repo = repository();
    const report = await integrateUpstream({
      ...integrateOptions(repo),
      checks: [
        [
          process.execPath,
          "-e",
          "require('fs').writeFileSync('core.txt','changed after merge')",
        ],
      ],
    });
    expect(report.status).toBe("checks-failed");
    expect(report.checks[0]?.stderr).toContain("changed candidate");
  });
  test("preserves dirty checkout and committed customizations while merging exact upstream", async () => {
    const repo = repository();
    const options = integrateOptions(repo);
    writeFileSync(join(repo.root, "core.txt"), "uncommitted work\n");
    writeFileSync(join(repo.root, "untracked.txt"), "keep\n");
    const head = git(repo.root, "rev-parse", "HEAD");
    const status = git(repo.root, "status", "--porcelain=v1");
    const report = await integrateUpstream(options);
    expect(report.status).toBe("ready");
    expect(report.accepted).toBe(false);
    expect(report.originalDirty).toBe(true);
    expect(readFileSync(join(repo.output, "core.txt"), "utf8")).toBe(
      "upstream\n",
    );
    expect(readFileSync(join(repo.output, "customer.txt"), "utf8")).toBe(
      "customer component\n",
    );
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo.root, "status", "--porcelain=v1")).toBe(status);
    expect(
      git(repo.output, "merge-base", "--is-ancestor", repo.upstream, "HEAD"),
    ).toBe("");
  });
  test("retains conflicting files and merge index in candidate without touching original", async () => {
    const repo = repository();
    writeFileSync(join(repo.root, "core.txt"), "fork modification\n");
    git(repo.root, "commit", "-am", "fork change");
    const head = git(repo.root, "rev-parse", "HEAD");
    const report = await integrateUpstream(integrateOptions(repo));
    expect(report.status).toBe("conflicts");
    expect(report.conflictingPaths).toEqual(["core.txt"]);
    expect(report.checks).toEqual([]);
    expect(readFileSync(join(repo.output, "core.txt"), "utf8")).toContain(
      "<<<<<<<",
    );
    expect(git(repo.output, "ls-files", "--unmerged")).not.toBe("");
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repo.root, "core.txt"), "utf8")).toBe(
      "fork modification\n",
    );
  });
  test("failed customization check leaves an unaccepted candidate with evidence", async () => {
    const repo = repository();
    const report = await integrateUpstream({
      ...integrateOptions(repo),
      checks: [
        [
          process.execPath,
          "-e",
          "console.error('custom component failed');process.exit(7)",
        ],
      ],
    });
    expect(report.status).toBe("checks-failed");
    expect(report.accepted).toBe(false);
    expect(report.checks[0]?.exitCode).toBe(7);
    expect(report.checks[0]?.stderr).toContain("custom component failed");
  });
  test.each([
    "unknown-baseline",
    "wrong-upstream-commit",
    "existing-output",
  ] as const)("refuses %s before changing checkout", async (failure) => {
    const repo = repository();
    const options = integrateOptions(repo);
    const status = git(repo.root, "status", "--porcelain=v1");
    if (failure === "unknown-baseline") options.baselineCommit = "f".repeat(40);
    if (failure === "wrong-upstream-commit")
      options.upstreamCommit = repo.baseline;
    if (failure === "existing-output") options.outputDirectory = repo.root;
    await expect(integrateUpstream(options)).rejects.toThrow();
    expect(git(repo.root, "status", "--porcelain=v1")).toBe(status);
  });
});

function releaseOptions(repo: ReturnType<typeof repository>) {
  const fixture = parseReleaseManifest(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, "../shared/fixtures/releases/candidate.json"),
        "utf8",
      ),
    ),
  );
  return {
    repositoryRoot: repo.root,
    outputDirectory: join(repo.root, "release"),
    repository: "acme/openbot",
    distributionId: "acme.openbot",
    channel: "stable",
    version: "v0.3.0",
    commit: git(repo.root, "rev-parse", "HEAD"),
    upstreamRepository: "CopilotKit/openbot",
    upstreamCommit: repo.baseline,
    compatibility: fixture.compatibility,
    upgrade: fixture.upgrade,
    images: fixture.artifacts.images,
  };
}
function releasePolicy(options: ReturnType<typeof releaseOptions>) {
  return {
    version: options.version,
    compatibility: options.compatibility,
    upgrade: options.upgrade,
  };
}
describe("release source artifacts", () => {
  test("publishes an exact chart artifact beside the source with a release-specific URL", () => {
    const repo = repository();
    const options = releaseOptions(repo);
    mkdirSync(join(repo.root, "openbot"));
    writeFileSync(
      join(repo.root, "openbot", "Chart.yaml"),
      "apiVersion: v2\nname: openbot\nversion: 0.1.4\n",
    );
    const chart = join(repo.root, "openbot-0.1.4.tgz");
    execFileSync("tar", ["-czf", chart, "-C", repo.root, "openbot"]);
    const release = createReleaseArtifacts({
      ...options,
      chart: { path: chart, version: "0.1.4" },
    });
    expect(release.artifacts.chart).toEqual({
      version: "0.1.4",
      url: "https://github.com/acme/openbot/releases/download/v0.3.0/openbot-0.1.4.tgz",
      sha256: createHash("sha256").update(readFileSync(chart)).digest("hex"),
    });
    expect(
      readFileSync(join(options.outputDirectory, "openbot-0.1.4.tgz")),
    ).toEqual(readFileSync(chart));
  });
  test("the publication CLI emits the fork's exact source and manifest without dependencies", () => {
    const repo = repository();
    writeFileSync(
      join(repo.root, "release-policy.json"),
      JSON.stringify(releasePolicy(releaseOptions(repo))),
    );
    git(repo.root, "add", "release-policy.json");
    git(repo.root, "commit", "-m", "release policy");
    const options = releaseOptions(repo);
    writeFileSync(
      join(repo.root, "container-images.json"),
      JSON.stringify({
        version: options.version,
        commit: options.commit,
        images: options.images,
      }),
    );
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/release-manifest.ts"),
      ],
      {
        cwd: repo.root,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: options.repository,
          GITHUB_SHA: options.commit,
          VERSION: options.version,
          OPENBOT_DISTRIBUTION_ID: options.distributionId,
          OPENBOT_UPSTREAM_COMMIT: options.upstreamCommit,
          OPENBOT_RELEASE_OUTPUT: options.outputDirectory,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(
      parseReleaseManifest(
        JSON.parse(
          readFileSync(
            join(options.outputDirectory, "release-manifest.json"),
            "utf8",
          ),
        ),
      ).distribution.id,
    ).toBe("acme.openbot");
  });
  test("archives exact committed source and hashes fork-owned metadata", () => {
    const repo = repository();
    writeFileSync(join(repo.root, "core.txt"), "uncommitted secret\n");
    const options = releaseOptions(repo);
    const release = createReleaseArtifacts(options);
    const archive = readFileSync(
      join(options.outputDirectory, "openbot-source.tar.gz"),
    );
    expect(release.source.modified).toBe(true);
    expect(release.artifacts.source.sha256).toBe(
      createHash("sha256").update(archive).digest("hex"),
    );
    expect(release.artifacts.source.url).toBe(
      "https://github.com/acme/openbot/releases/download/v0.3.0/openbot-source.tar.gz",
    );
    expect(
      execFileSync(
        "tar",
        [
          "-xzOf",
          join(options.outputDirectory, "openbot-source.tar.gz"),
          "openbot/core.txt",
        ],
        { encoding: "utf8" },
      ),
    ).toBe("original\n");
    expect(
      parseReleaseManifest(
        JSON.parse(
          readFileSync(
            join(options.outputDirectory, "release-manifest.json"),
            "utf8",
          ),
        ),
      ),
    ).toEqual(release);
  });
  test("requires a recorded upstream ancestor and fork-owned image references", () => {
    const repo = repository();
    const options = releaseOptions(repo);
    expect(() =>
      createReleaseArtifacts({ ...options, upstreamCommit: repo.upstream }),
    ).toThrow();
    expect(existsSync(options.outputDirectory)).toBe(false);
    expect(() =>
      createReleaseArtifacts({
        ...options,
        images: {
          server: {
            reference: `ghcr.io/copilotkit/openbot-server@sha256:${"b".repeat(64)}`,
          },
        },
      }),
    ).toThrow();
    expect(existsSync(options.outputDirectory)).toBe(false);
  });
  test("publication refuses a fork without a baseline and a commit without a policy", () => {
    const repo = repository();
    const options = releaseOptions(repo);
    const env = {
      GITHUB_REPOSITORY: "acme/openbot",
      GITHUB_SHA: options.commit,
      VERSION: "v0.3.0",
    };
    expect(() => readReleaseConfiguration(env, repo.root)).toThrow(
      "Fork publication requires",
    );
    expect(() =>
      readReleasePolicy(repo.root, options.commit, options.version),
    ).toThrow("has no release-policy.json");
  });
});

describe("release workflow invariants", () => {
  test("the candidate path uses runner environment only inside a supported step", () => {
    const source = readFileSync(
      join(import.meta.dir, "../.github/workflows/upstream-upgrade.yml"),
      "utf8",
    );
    const jobEnvironment = source.match(/ {4}env:\n([\s\S]*?) {4}steps:/)?.[1];
    expect(jobEnvironment).toBeDefined();
    expect(jobEnvironment).not.toContain("${{ runner.");
    expect(source).toContain(
      'echo "CANDIDATE=$RUNNER_TEMP/openbot-upstream-candidate" >> "$GITHUB_ENV"',
    );
  });
  test.each(["publish-release", "upstream-upgrade"])(
    "%s is valid YAML with pinned actions",
    (name) => {
      const source = readFileSync(
        join(import.meta.dir, `../.github/workflows/${name}.yml`),
        "utf8",
      );
      expect(() => Bun.YAML.parse(source)).not.toThrow();
      for (const match of source.matchAll(/^\s+(?:- )?uses: (\S+)/gm))
        expect(match[1]).toMatch(
          /^(?:\$\/\.github\/workflows\/[A-Za-z0-9_.-]+\.yml|[A-Za-z0-9_./-]+@[0-9a-f]{40})$/,
        );
    },
  );
  test("publication uses this repository and attests both source and metadata", () => {
    const source = readFileSync(
      join(import.meta.dir, "../.github/workflows/publish-release.yml"),
      "utf8",
    );
    expect(source).not.toContain("ghcr.io/copilotkit/");
    expect(source).toContain("uses: $/.github/workflows/ci.yml");
    expect(source).toContain(
      "run: bun scripts/release-manifest.ts --validate-policy",
    );
    expect(source).toContain("release-assets/release-manifest.json");
    expect(source).toContain("release-assets/openbot-source.tar.gz");
    expect(source).toContain("container-images.json release-assets/*");
  });
});
