import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readReleaseFiles } from "../scripts/release-manifest";
import candidate from "../shared/fixtures/releases/candidate.json";
import { parseReleaseManifest } from "../shared/release-manifest";
import { releaseFiles } from "./support/release-files";

// Each case packages two charts with real `helm` and archives a git tree.
setDefaultTimeout(30_000);

// A release attaches two Helm charts, `openbot` and `openbot-bundle`. They are published with the
// OpenBot images of the release, signed with the same key, and the release fetches them, attaches
// them and records both in its manifest. Before this, the publish workflow packaged no chart and
// the manifest could name one at most, so a release from main had none.

const root = join(import.meta.dir, "..");
const cli = join(root, "scripts/release-manifest.ts");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function scratch(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function published(options: Parameters<typeof releaseFiles>[0]) {
  const files = releaseFiles(options);
  directories.push(dirname(files));
  return files;
}

/** A release commit as the publish workflow sees it: the policy, the image pins, and no charts. */
function release(version: string) {
  const repo = scratch("openbot-charts-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "core.txt"), "release\n");
  writeFileSync(
    join(repo, "release-policy.json"),
    JSON.stringify({
      version,
      compatibility: candidate.compatibility,
      upgrade: candidate.upgrade,
    }),
  );
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "release",
  );
  writeFileSync(
    join(repo, "container-images.json"),
    JSON.stringify({
      version,
      images: {
        openbot: {
          reference: `ghcr.io/copilotkit/openbot@sha256:${"b".repeat(64)}`,
        },
      },
    }),
  );
  return { repo, commit: git(repo, "rev-parse", "HEAD") };
}
/** The "Archive exact source and write release manifest" step. */
function publish(
  rel: ReturnType<typeof release>,
  version: string,
  files?: string,
) {
  const run = Bun.spawnSync([process.execPath, cli], {
    cwd: rel.repo,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GITHUB_REPOSITORY: "CopilotKit/OpenBot",
      GITHUB_SHA: rel.commit,
      VERSION: version,
      ...(files ? { OPENBOT_RELEASE_FILES: files } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stderr: run.stderr.toString() };
}

describe("a release's Helm charts", () => {
  test("both are attached at the release's own address and listed in release-charts.json", () => {
    const rel = release("v0.4.0");
    const files = published({
      version: "v0.4.0",
      database: candidate.compatibility.database.to,
    });
    expect(publish(rel, "v0.4.0", files)).toEqual({ exitCode: 0, stderr: "" });

    const assets = join(rel.repo, "release-assets");
    expect(readdirSync(assets).sort()).toEqual([
      "openbot-0.3.0.tgz",
      "openbot-bundle-0.1.0.tgz",
      "openbot-source.tar.gz",
      "release-charts.json",
      "release-manifest.json",
    ]);
    const address =
      "https://github.com/CopilotKit/OpenBot/releases/download/v0.4.0";
    const openbot = {
      version: "0.3.0",
      url: `${address}/openbot-0.3.0.tgz`,
      sha256: sha256(join(files, "openbot-0.3.0.tgz")),
    };
    expect(
      JSON.parse(readFileSync(join(assets, "release-charts.json"), "utf8")),
    ).toEqual({
      version: "v0.4.0",
      charts: {
        openbot,
        "openbot-bundle": {
          version: "0.1.0",
          url: `${address}/openbot-bundle-0.1.0.tgz`,
          sha256: sha256(join(files, "openbot-bundle-0.1.0.tgz")),
        },
      },
    });

    // THE MANIFEST KEEPS THE SHAPE RELEASED READERS ACCEPT. `scripts/update.ts` of 1.0.3 and
    // earlier, which a source install and a Kubernetes promotion run to move to the next release,
    // refuses a manifest with a field it does not know ("artifacts: missing or unsupported
    // fields"). So the manifest names the `openbot` chart as it always has, and nothing else.
    const written = JSON.parse(
      readFileSync(join(assets, "release-manifest.json"), "utf8"),
    );
    expect(Object.keys(written).sort()).toEqual([
      "artifacts",
      "compatibility",
      "distribution",
      "schemaVersion",
      "source",
      "upgrade",
      "version",
    ]);
    expect(Object.keys(written.artifacts).sort()).toEqual([
      "chart",
      "images",
      "source",
    ]);
    expect(parseReleaseManifest(written).artifacts.chart).toEqual(openbot);
    // What is attached is byte for byte what was published and signed.
    for (const name of ["openbot-0.3.0.tgz", "openbot-bundle-0.1.0.tgz"])
      expect(sha256(join(assets, name))).toBe(sha256(join(files, name)));
    // Real Helm reads each as the chart it is named for.
    for (const [name, file] of [
      ["openbot", "openbot-0.3.0.tgz"],
      ["openbot-bundle", "openbot-bundle-0.1.0.tgz"],
    ])
      expect(
        execFileSync("helm", ["show", "chart", join(assets, file!)], {
          encoding: "utf8",
        }),
      ).toContain(`name: ${name}\n`);
  });

  test.each([
    [
      "charts packaged for another release",
      () =>
        published({
          version: "v0.4.0",
          database: "openbot-db-1",
          appVersion: "0.3.9",
        }),
      'openbot-0.3.0.tgz installs OpenBot "0.3.9" (its appVersion), but this release is v0.4.0',
    ],
    [
      "release files published for another version",
      () => published({ version: "v0.3.9", database: "openbot-db-1" }),
      'openbot-release.json is for "v0.3.9", but this release is v0.4.0',
    ],
    [
      "a chart that is not the file the release files list",
      () => {
        const files = published({
          version: "v0.4.0",
          database: "openbot-db-1",
        });
        writeFileSync(join(files, "openbot-bundle-0.1.0.tgz"), "tampered");
        return files;
      },
      "openbot-bundle-0.1.0.tgz is not the file openbot-release.json lists",
    ],
    [
      "release files with no bundle chart",
      () =>
        published({
          version: "v0.4.0",
          database: "openbot-db-1",
          charts: { openbot: "0.3.0" },
        }),
      "openbot-release.json lists no openbot-bundle chart",
    ],
    [
      "a bundle chart packaged under the openbot chart's name",
      () => {
        const files = published({
          version: "v0.4.0",
          database: "openbot-db-1",
          charts: { openbot: "0.3.0" },
        });
        const release = JSON.parse(
          readFileSync(join(files, "openbot-release.json"), "utf8"),
        );
        writeFileSync(
          join(files, "openbot-bundle-0.3.0.tgz"),
          readFileSync(join(files, "openbot-0.3.0.tgz")),
        );
        release.charts["openbot-bundle"] = release.charts.openbot;
        writeFileSync(
          join(files, "openbot-release.json"),
          JSON.stringify(release),
        );
        return files;
      },
      "openbot-bundle-0.3.0.tgz is not the openbot-bundle chart at 0.3.0",
    ],
  ])("refuses %s, before it writes anything", (_name, files, reason) => {
    const rel = release("v0.4.0");
    const result = publish(rel, "v0.4.0", files());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(reason);
    expect(existsSync(join(rel.repo, "release-assets"))).toBe(false);
  });

  test("the files are read as what they are, by the function the release uses", () => {
    const files = published({
      version: "v0.4.0",
      database: "0091_last",
      requiresDowntime: true,
    });
    expect(readReleaseFiles(files, "v0.4.0")).toEqual({
      database: "0091_last",
      requiresDowntime: true,
      chart: { path: join(files, "openbot-0.3.0.tgz"), version: "0.3.0" },
      bundleChart: {
        path: join(files, "openbot-bundle-0.1.0.tgz"),
        version: "0.1.0",
      },
    });
    // A chart from before the value rolls its servers.
    expect(
      readReleaseFiles(
        published({ version: "v0.4.0", database: "0091_last" }),
        "v0.4.0",
      ).requiresDowntime,
    ).toBe(false);
  });
});

/**
 * `scripts/release-files.sh` against a pretend `cosign` and `docker`: what it asks of each, in
 * order. The registry and the signature are the two things a test cannot hold, so they are the two
 * things stood in for; the files the pretend docker hands over are real packaged charts.
 */
describe("fetching the release files", () => {
  const DIGEST = `sha256:${"c".repeat(64)}`;
  function fakes(signed: boolean) {
    const directory = scratch("openbot-fetch-");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const log = join(directory, "calls.log");
    writeFileSync(log, "");
    writeFileSync(
      join(bin, "cosign"),
      `#!/usr/bin/env bash
printf '%s\\n' "cosign $*" >> "$FAKE_LOG"
if [ "$FAKE_SIGNED" != true ]; then echo "Error: no matching signatures" >&2; exit 1; fi
printf '[{"critical":{"image":{"docker-manifest-digest":"%s"}}}]\\n' "${DIGEST}"
`,
    );
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash
printf '%s\\n' "docker $*" >> "$FAKE_LOG"
case "$1" in
  create) echo container-1 ;;
  cp) cp -R "$FAKE_FILES/." "$3" ;;
esac
`,
    );
    chmodSync(join(bin, "cosign"), 0o755);
    chmodSync(join(bin, "docker"), 0o755);
    const files = published({ version: "v0.4.0", database: "0091_last" });
    const out = join(directory, "out");
    const run = (reference: string) => {
      const result = Bun.spawnSync(
        ["bash", join(root, "scripts/release-files.sh"), reference, out],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_LOG: log,
            FAKE_SIGNED: String(signed),
            FAKE_FILES: files,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { run, calls, out };
  }
  const key = join(root, "docs/cosign.pub");

  test("verifies the tag's signature with OpenBot's key, then takes the files by the digest it names", () => {
    const fake = fakes(true);
    const result = fake.run("v0.4.0");
    expect(result).toEqual({
      code: 0,
      stdout: `${DIGEST}\n`,
      stderr: expect.any(String),
    });
    expect(fake.calls()).toEqual([
      `cosign verify --key ${key} --insecure-ignore-tlog=true ghcr.io/copilotkit/openbot:charts-v0.4.0`,
      `docker create ghcr.io/copilotkit/openbot@${DIGEST} /release`,
      `docker cp container-1:/release/. ${fake.out}`,
      "docker rm -f container-1",
    ]);
    // What arrived is a folder the release accepts.
    expect(readReleaseFiles(fake.out, "v0.4.0").database).toBe("0091_last");
  });

  test("fetches by digest what an earlier step verified, and verifies it again", () => {
    const fake = fakes(true);
    expect(fake.run(DIGEST).code).toBe(0);
    expect(fake.calls()[0]).toBe(
      `cosign verify --key ${key} --insecure-ignore-tlog=true ghcr.io/copilotkit/openbot@${DIGEST}`,
    );
  });

  test("takes nothing that is unsigned or not there", () => {
    const fake = fakes(false);
    const result = fake.run("v0.4.0");
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("is not signed with OpenBot's key");
    expect(fake.calls().some((call) => call.startsWith("docker"))).toBe(false);
    expect(existsSync(fake.out)).toBe(false);
  });
});

describe("the release workflow", () => {
  const jobs = (
    Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/publish-release.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          outputs?: Record<string, string>;
          steps: {
            id?: string;
            name?: string;
            run?: string;
            env?: Record<string, string>;
            with?: Record<string, string>;
          }[];
        }
      >;
    }
  ).jobs;
  /** A workflow expression, as the YAML writes it. */
  const expression = (value: string) => `\${{ ${value} }}`;
  const step = (job: string, name: string) => {
    const steps = jobs[job]!.steps;
    const index = steps.findIndex((candidate) => candidate.name === name);
    expect([name, index]).not.toEqual([name, -1]);
    return { index, step: steps[index]! };
  };

  test("verify checks the policy against the release files it fetched and verified", () => {
    const fetch = step(
      "verify",
      "Fetch the release files published with this release's OpenBot images",
    );
    const validate = step(
      "verify",
      "Validate release compatibility and source baseline",
    );
    expect(fetch.index).toBeLessThan(validate.index);
    expect(fetch.step.run).toContain(
      'scripts/release-files.sh "$tag" "$RUNNER_TEMP/release-files"',
    );
    expect(validate.step.env).toMatchObject({
      OPENBOT_RELEASE_FILES: `${expression("runner.temp")}/release-files`,
      OPENBOT_RELEASE_MANIFESTS: `${expression("runner.temp")}/release-manifests`,
    });
    expect(jobs.verify!.outputs?.release_files).toBe(
      expression("steps.files.outputs.digest"),
    );
  });

  /**
   * A release whose `tag and release` job failed is completed by re-running that job alone. The
   * image list it attaches was uploaded by `image list` in the first attempt, which is not run
   * again, so its artifact has to be findable from any attempt of the same run. Named with the
   * attempt number, the re-run asked for `desktop-images-<run>-2`, which nothing ever uploaded.
   */
  test("a re-run of tag and release alone finds the image list the first attempt uploaded", () => {
    const uploads = jobs["image-list"]!.steps.filter((candidate) =>
      String((candidate as { uses?: string }).uses).startsWith(
        "actions/upload-artifact@",
      ),
    );
    expect(uploads).toHaveLength(1);
    const uploaded = uploads[0]!.with!;
    const downloads = jobs["github-release"]!.steps.filter((candidate) =>
      String((candidate as { uses?: string }).uses).startsWith(
        "actions/download-artifact@",
      ),
    ).map((candidate) => candidate.with?.name);
    expect(downloads).toContain(uploaded.name);
    expect(uploaded.name).toBe(`desktop-images-${expression("github.run_id")}`);
    for (const name of downloads) expect(name).not.toContain("run_attempt");
    // A re-run of the whole workflow uploads it again under the same name.
    expect(uploaded.overwrite).toBe(true);
  });

  test("the release attaches and attests the charts verify checked, by their digest", () => {
    const fetch = step("github-release", "Fetch this release's Helm charts");
    const write = step(
      "github-release",
      "Archive exact source and write release manifest",
    );
    expect(fetch.index).toBeLessThan(write.index);
    expect(fetch.step.env?.RELEASE_FILES).toBe(
      expression("needs.verify.outputs.release_files"),
    );
    expect(write.step.env?.OPENBOT_RELEASE_FILES).toBe(
      `${expression("runner.temp")}/release-files`,
    );
    const attest = step(
      "github-release",
      "Authenticate release metadata, source archive and charts",
    );
    expect(attest.step.with?.["subject-path"]).toContain(
      "release-assets/*.tgz",
    );
    expect(attest.step.with?.["subject-path"]).toContain(
      "release-assets/release-charts.json",
    );
    // Everything in release-assets is uploaded, the charts with it.
    expect(step("github-release", "Tag and publish").step.run).toContain(
      'gh release create "$VERSION" container-images.json desktop-images.json release-assets/*',
    );
  });
});
