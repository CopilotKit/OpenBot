import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A namespace import, so each test fails on its own if a function it drives is missing.
import * as releaseManifest from "../scripts/release-manifest";
import { parseReleaseManifest } from "../shared/release-manifest";

// A release that failed partway is completed by rerunning it. The rerun packages the chart again
// with real `helm package`, which stamps the time it ran, so its bytes always differ from what the
// first attempt published even though nothing changed.

const cli = join(import.meta.dir, "../scripts/release-manifest.ts");
const fixtures = join(import.meta.dir, "../shared/fixtures/releases");
const candidate = JSON.parse(
  readFileSync(join(fixtures, "candidate.json"), "utf8"),
);
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
const BUNDLE = "release-provenance.sigstore.json";
/** Every file a .tgz unpacks to, with its content, read with tar rather than the code under test. */
function unpacked(archive: string): Record<string, string> {
  const directory = scratch("openbot-unpacked-");
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  const files: Record<string, string> = {};
  const walk = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(path, entry.name), `${name}/`);
      else files[name] = readFileSync(join(path, entry.name), "utf8");
    }
  };
  walk(directory, "");
  return files;
}
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** A fork release commit with a real chart and its reviewed policy. */
function release() {
  const repo = scratch("openbot-rerun-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "core.txt"), "original\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "baseline",
  );
  const upstream = git(repo, "rev-parse", "HEAD");
  mkdirSync(join(repo, "charts/openbot/templates"), { recursive: true });
  writeFileSync(
    join(repo, "charts/openbot/Chart.yaml"),
    'apiVersion: v2\nname: openbot\nversion: 0.1.4\nappVersion: "0.3.0"\n',
  );
  writeFileSync(join(repo, "charts/openbot/values.yaml"), "replicas: 1\n");
  writeFileSync(
    join(repo, "charts/openbot/templates/configmap.yaml"),
    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\ndata:\n  replicas: {{ .Values.replicas | quote }}\n",
  );
  writeFileSync(
    join(repo, "release-policy.json"),
    JSON.stringify({
      version: "v0.3.0",
      compatibility: candidate.compatibility,
      upgrade: candidate.upgrade,
    }),
  );
  writeFileSync(
    join(repo, "container-images.json"),
    JSON.stringify({ version: "v0.3.0", images: candidate.artifacts.images }),
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
  return { repo, upstream, commit: git(repo, "rev-parse", "HEAD") };
}
/** `helm package`, into the release assets, after the chart's files were touched at a new time. */
function packageChart(repo: string, stamp: number) {
  for (const file of ["Chart.yaml", "values.yaml", "templates/configmap.yaml"])
    utimesSync(join(repo, "charts/openbot", file), stamp, stamp);
  mkdirSync(join(repo, "release-assets"), { recursive: true });
  execFileSync("helm", [
    "package",
    join(repo, "charts/openbot"),
    "--destination",
    join(repo, "release-assets"),
  ]);
  return join(repo, "release-assets/openbot-0.1.4.tgz");
}
/** One attempt of the "Archive exact source and write release manifest" step. */
function attempt(
  rel: ReturnType<typeof release>,
  published?: string,
): { exitCode: number; stderr: string } {
  const run = Bun.spawnSync([process.execPath, cli], {
    cwd: rel.repo,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "acme/openbot",
      GITHUB_SHA: rel.commit,
      VERSION: "v0.3.0",
      OPENBOT_DISTRIBUTION_ID: "acme.openbot",
      OPENBOT_UPSTREAM_COMMIT: rel.upstream,
      OPENBOT_CHART_PATH: "release-assets/openbot-0.1.4.tgz",
      OPENBOT_CHART_VERSION: "0.1.4",
      ...(published ? { OPENBOT_PUBLISHED_ASSETS: published } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stderr: run.stderr.toString() };
}
/** What the first attempt managed to upload before it failed: everything but the given assets. */
function publish(repo: string, missing: string[]) {
  const published = scratch("openbot-published-");
  for (const name of readdirSync(join(repo, "release-assets")))
    if (!missing.includes(name))
      copyFileSync(join(repo, "release-assets", name), join(published, name));
  if (!missing.includes("container-images.json"))
    copyFileSync(
      join(repo, "container-images.json"),
      join(published, "container-images.json"),
    );
  return published;
}

describe("rerunning a half-published release", () => {
  test("completes it: the rerun keeps every published asset and its manifest describes them", async () => {
    const rel = release();
    const first = Date.now() / 1000 - 3600;
    packageChart(rel.repo, first);
    expect(attempt(rel)).toEqual({ exitCode: 0, stderr: "" });
    const firstManifest = readFileSync(
      join(rel.repo, "release-assets/release-manifest.json"),
      "utf8",
    );
    // The first attempt uploaded the chart, the source and container-images.json, then failed.
    const published = publish(rel.repo, ["release-manifest.json"]);
    rmSync(join(rel.repo, "release-assets"), { recursive: true });

    // Rerun: the chart is packaged again, later, as the workflow does.
    await Bun.sleep(1100);
    const rebuilt = packageChart(rel.repo, first + 60);
    expect(sha256(rebuilt)).not.toBe(
      sha256(join(published, "openbot-0.1.4.tgz")),
    );
    expect(unpacked(rebuilt)).toEqual(
      unpacked(join(published, "openbot-0.1.4.tgz")),
    );

    expect(attempt(rel, published)).toEqual({ exitCode: 0, stderr: "" });
    for (const name of ["openbot-0.1.4.tgz", "openbot-source.tar.gz"])
      expect(sha256(join(rel.repo, "release-assets", name))).toBe(
        sha256(join(published, name)),
      );
    const manifest = parseReleaseManifest(
      JSON.parse(
        readFileSync(
          join(rel.repo, "release-assets/release-manifest.json"),
          "utf8",
        ),
      ),
    );
    expect(manifest.artifacts.chart?.sha256).toBe(
      sha256(join(published, "openbot-0.1.4.tgz")),
    );
    expect(manifest.artifacts.source.sha256).toBe(
      sha256(join(published, "openbot-source.tar.gz")),
    );
    // The manifest the first attempt never uploaded is the one it would have uploaded.
    expect(
      readFileSync(
        join(rel.repo, "release-assets/release-manifest.json"),
        "utf8",
      ),
    ).toBe(firstManifest);
  });

  test("keeps a published manifest when the rerun describes the same release", () => {
    const rel = release();
    packageChart(rel.repo, Date.now() / 1000 - 3600);
    expect(attempt(rel).exitCode).toBe(0);
    const published = publish(rel.repo, []);
    rmSync(join(rel.repo, "release-assets"), { recursive: true });
    packageChart(rel.repo, Date.now() / 1000);
    expect(attempt(rel, published)).toEqual({ exitCode: 0, stderr: "" });
    for (const name of readdirSync(published))
      expect(
        sha256(
          join(
            rel.repo,
            name === "container-images.json" ? "" : "release-assets",
            name,
          ),
        ),
      ).toBe(sha256(join(published, name)));
  });

  test.each([
    [
      "a chart whose templates changed",
      (repo: string, published: string) => {
        const changed = scratch("openbot-changed-");
        cpSync(join(repo, "charts/openbot"), join(changed, "openbot"), {
          recursive: true,
        });
        writeFileSync(join(changed, "openbot/values.yaml"), "replicas: 2\n");
        execFileSync("helm", [
          "package",
          join(changed, "openbot"),
          "--destination",
          published,
        ]);
      },
      "openbot-0.1.4.tgz has different content",
    ],
    [
      "images rebuilt under new digests",
      (_repo: string, published: string) => {
        const images = JSON.parse(
          readFileSync(join(published, "container-images.json"), "utf8"),
        );
        images.images.server.reference = images.images.server.reference.replace(
          /@sha256:./,
          "@sha256:f",
        );
        writeFileSync(
          join(published, "container-images.json"),
          JSON.stringify(images),
        );
      },
      "container-images.json has different content",
    ],
  ])(
    "refuses to complete a release when the published %s",
    (_name, change, reason) => {
      const rel = release();
      packageChart(rel.repo, Date.now() / 1000 - 3600);
      expect(attempt(rel).exitCode).toBe(0);
      const published = publish(rel.repo, ["release-manifest.json"]);
      change(rel.repo, published);
      rmSync(join(rel.repo, "release-assets"), { recursive: true });
      packageChart(rel.repo, Date.now() / 1000);
      const result = attempt(rel, published);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(reason);
    },
  );
});

describe("the provenance bundle on a rerun", () => {
  const real = readFileSync(join(fixtures, "provenance.sigstore.json"), "utf8");
  function bundle(
    change: (
      statement: { subject: unknown[] },
      bundle: {
        dsseEnvelope: { payload: string; signatures: { sig: string }[] };
      },
    ) => void,
  ) {
    const parsed = JSON.parse(real);
    const statement = JSON.parse(
      Buffer.from(parsed.dsseEnvelope.payload, "base64").toString("utf8"),
    );
    change(statement, parsed);
    parsed.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(statement),
    ).toString("base64");
    return JSON.stringify(parsed);
  }
  function directoryWith(contents: string) {
    const directory = scratch("openbot-provenance-");
    writeFileSync(join(directory, BUNDLE), contents);
    return directory;
  }

  test("keeps the published bundle when the new one is a fresh signature over the same assets", () => {
    const published = directoryWith(real);
    const local = join(
      directoryWith(
        bundle((statement, envelope) => {
          (statement as { predicate?: unknown }).predicate = { rerun: true };
          envelope.dsseEnvelope.signatures[0]!.sig =
            Buffer.from("re-signed").toString("base64");
        }),
      ),
      BUNDLE,
    );
    expect(readFileSync(local, "utf8")).not.toBe(real);
    expect(releaseManifest.adoptPublishedProvenance(local, published)).toBe(
      true,
    );
    expect(readFileSync(local, "utf8")).toBe(real);
  });

  test("uses the new bundle when the published one attests assets that were never published", () => {
    const published = directoryWith(real);
    const replacement = bundle((statement) => {
      statement.subject.push({
        name: "openbot-0.1.4.tgz",
        digest: { sha256: "a".repeat(64) },
      });
    });
    const local = join(directoryWith(replacement), BUNDLE);
    expect(releaseManifest.adoptPublishedProvenance(local, published)).toBe(
      false,
    );
    expect(readFileSync(local, "utf8")).toBe(replacement);
  });
});

describe("the release workflow", () => {
  const steps = (
    Bun.YAML.parse(
      readFileSync(
        join(import.meta.dir, "../.github/workflows/publish-release.yml"),
        "utf8",
      ),
    ) as {
      jobs: Record<
        string,
        {
          steps: {
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }[];
        }
      >;
    }
  ).jobs["github-release"]!.steps;
  const index = (name: string) => steps.findIndex((step) => step.name === name);

  test("fetches what was published before it writes, attests and compares anything", () => {
    const fetch = index("Fetch what an earlier attempt already published");
    expect(fetch).toBeGreaterThan(index("Package this release's chart"));
    expect(fetch).toBeLessThan(
      index("Archive exact source and write release manifest"),
    );
    expect(steps[fetch]!.run).toContain(
      'echo "OPENBOT_PUBLISHED_ASSETS=$published" >> "$GITHUB_ENV"',
    );
    expect(steps[index("Save portable provenance bundle")]!.run).toContain(
      "bun scripts/release-manifest.ts --adopt-provenance release-assets/release-provenance.sigstore.json",
    );
    const publish = steps[index("Tag and publish")]!.run!;
    expect(publish).toContain('elif ! cmp -s "$artifact" "$published"; then');
    expect(publish).toContain(
      'gh release upload "$VERSION" "$artifact" --clobber',
    );
    expect(publish).toContain(
      'gh release create "$VERSION" container-images.json release-assets/*',
    );
  });
});
