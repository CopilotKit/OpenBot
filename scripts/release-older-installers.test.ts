/**
 * When a release becomes Latest, the installers of every older release go, from GitHub and from
 * downloads.copilotkit.ai (scripts/release-older-installers.sh). An installer from before 1.1.0
 * lays out the Latest release's server stack on a fresh install without the install token that
 * stack requires, so it crash-loops. Everything an installed app reads to update or repair stays.
 *
 * The rule runs against the real release list (release-older-installers.fixture.json), and the
 * GitHub and bucket sides run against the pretend `gh` and `aws` the other release scripts use.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUCKET, DISTRIBUTION, fakeDownloads } from "./downloads-fakes";
import { fakeRepo, feedFor, runScript } from "./release-fakes";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts/release-older-installers.sh");
const makeLatest = join(root, "scripts/release-make-latest.sh");

setDefaultTimeout(20_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Release = { tag: string; assets: string[] };
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "release-older-installers.fixture.json"),
    "utf8",
  ),
) as { latest: string; releases: Release[]; removed: string[] };

/** "<tag> <name>" for each installer removed by hand on 2026-11-17, as that removal recorded it. */
const removedByHand = fixture.removed.map((line) => line.replace(" ", "\t"));

/** The real release list as it stood before the installers were removed by hand. */
function before(): Release[] {
  return fixture.releases.map((release) => ({
    tag: release.tag,
    assets: [
      ...release.assets,
      ...fixture.removed
        .filter((line) => line.startsWith(`${release.tag} `))
        .map((line) => line.slice(release.tag.length + 1)),
    ],
  }));
}

function select(releases: Release[], latest: string) {
  const result = Bun.spawnSync(["bash", script, "select", latest], {
    stdin: Buffer.from(JSON.stringify(releases)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    lines: result.stdout.toString().split("\n").filter(Boolean),
    err: result.stderr.toString(),
  };
}

const sorted = (lines: string[]) => [...lines].sort();

test("Latest v1.1.0 removes the installers of every older release, and keeps all their other files", () => {
  const releases = before();
  const result = select(releases, "v1.1.0");
  expect(result.code).toBe(0);
  // Exactly the 134 assets removed by hand: each .dmg and -setup.exe under its versioned and fixed
  // name, and each installer's .sig, on every release from v0.0.13 to v1.1.0-rc.2.
  expect(result.lines.length).toBe(134);
  expect(sorted(result.lines)).toEqual(sorted(removedByHand));
  // v1.1.0 keeps everything. On every older release, each feed, updater archive and its .sig,
  // image list, source, manifest and provenance stays.
  const removed = new Set(result.lines);
  expect(result.lines.filter((line) => line.startsWith("v1.1.0\t"))).toEqual(
    [],
  );
  for (const release of releases) {
    if (release.tag === "v1.1.0") continue;
    for (const name of release.assets) {
      if (!removed.has(`${release.tag}\t${name}`)) {
        expect(name).not.toMatch(/\.(dmg|exe|msi|AppImage|deb|rpm)(\.sig)?$/);
      }
    }
  }
  expect(removed.has("v1.0.3\tOpenBot-darwin-aarch64.app.tar.gz.sig")).toBe(
    false,
  );
  expect(removed.has("v1.0.3\tcontainer-images.json")).toBe(false);
  expect(removed.has("v1.0.3\topenbot-source.tar.gz")).toBe(false);
});

test("the release list as it stands now has nothing left to remove", () => {
  const result = select(fixture.releases, fixture.latest);
  expect(result.code).toBe(0);
  expect(result.lines).toEqual([]);
});

test("the Latest release, a newer candidate and a tag that is not a version are untouched", () => {
  const installers = [
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
    "OpenBot-windows-x64-setup.exe",
    "OpenBot_1.1.1-rc.1_aarch64.dmg",
    "OpenBot_1.1.1-rc.1_x64.dmg",
    "OpenBot_1.1.1-rc.1_x64-setup.exe",
    "OpenBot_1.1.1-rc.1_x64-setup.exe.sig",
  ];
  const releases = [
    { tag: "v1.1.1-rc.1", assets: installers },
    ...before(),
    { tag: "desktop-shell", assets: ["OpenBot_0.0.1_aarch64.dmg"] },
    { tag: "v1.0", assets: ["OpenBot_1.0_aarch64.dmg"] },
    { tag: "1.0.0", assets: ["OpenBot_1.0.0_aarch64.dmg"] },
  ];
  const result = select(releases, "v1.1.0");
  expect(result.code).toBe(0);
  expect(sorted(result.lines)).toEqual(sorted(removedByHand));
  for (const tag of [
    "v1.1.0",
    "v1.1.1-rc.1",
    "desktop-shell",
    "v1.0",
    "1.0.0",
  ]) {
    expect(result.lines.filter((line) => line.startsWith(`${tag}\t`))).toEqual(
      [],
    );
  }
});

test("versions compare by semver: a candidate of the Latest version is older, the next patch is not", () => {
  const result = select(before(), "v1.0.0");
  expect(result.code).toBe(0);
  const tags = [...new Set(result.lines.map((line) => line.split("\t")[0]))];
  expect(tags.sort()).toEqual(
    [
      "v1.0.0-rc.5",
      "v1.0.0-rc.4",
      "v1.0.0-rc.3",
      "v1.0.0-rc.2",
      "v1.0.0-rc.1",
      "v0.3.4",
      "v0.3.3",
      "v0.3.2",
      "v0.3.1",
      "v0.3.0",
      "v0.0.13",
    ].sort(),
  );
  // 10 < 9 as text, not as a version.
  const ten = select(
    [
      { tag: "v0.9.0", assets: ["a.dmg"] },
      { tag: "v0.10.0", assets: ["b.dmg"] },
    ],
    "v0.10.0",
  );
  expect(ten.lines).toEqual(["v0.9.0\ta.dmg"]);
});

test("a Latest tag that is not a stable version removes nothing and fails", () => {
  for (const latest of ["v1.1.1-rc.1", "latest", "1.1.0", ""]) {
    const result = select(before(), latest);
    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
    expect(result.err).toContain("is not a stable version");
  }
});

/** The real list before the removal, on a pretend repository whose Latest is v1.1.0. */
function repoBefore() {
  const repo = fakeRepo("v1.1.0");
  cleanups.push(repo.cleanup);
  repo.releases(before());
  return repo;
}

test("on GitHub a dry run lists what would go and removes nothing; a real run removes exactly that", () => {
  const repo = repoBefore();
  const dry = runScript(script, ["github", "--dry-run"], repo, {}, repo.dir);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain(
    "Would remove OpenBot_1.0.3-rc.1_x64-setup.exe from v1.0.3-rc.1.",
  );
  expect(dry.out).toContain(
    "134 installers on releases older than v1.1.0 would be removed. This was a dry run",
  );
  expect(repo.calls().some((call) => call.includes("delete-asset"))).toBe(
    false,
  );
  expect(repo.releaseList()).toEqual(before());

  const run = runScript(script, ["github"], repo, {}, repo.dir);
  expect(run.code).toBe(0);
  const deletes = repo
    .calls()
    .filter((call) => call.startsWith("gh release delete-asset"));
  expect(deletes.length).toBe(134);
  expect(deletes).toContain(
    "gh release delete-asset v1.0.2 OpenBot_1.0.2_x64-setup.exe.sig -R CopilotKit/OpenBot --yes",
  );
  // What is left is the list as it stands today, after the removal by hand.
  expect(repo.releaseList()).toEqual(fixture.releases);

  // Again: nothing left.
  const again = runScript(script, ["github"], repo, {}, repo.dir);
  expect(again.code).toBe(0);
  expect(again.out).toContain(
    "Nothing to remove: no release older than v1.1.0 has an installer.",
  );
});

test("making a stable release Latest removes the installers of every older release", () => {
  const repo = repoBefore();
  repo.setLatest("v1.0.3");
  repo.attachFile("latest.json", JSON.stringify(feedFor("1.1.0")));
  repo.attach(
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
    "OpenBot-windows-x64-setup.exe",
  );
  const result = runScript(
    makeLatest,
    [],
    repo,
    { RELEASE_TAG: "v1.1.0", MAKE_LATEST: "true", FEED_RETRY_DELAY: "0" },
    repo.dir,
  );
  expect(result.code).toBe(0);
  expect(repo.latest()).toBe("v1.1.0");
  const calls = repo.calls();
  // After the release is Latest and the sync is started, never before.
  const edit = calls.indexOf(
    "gh release edit v1.1.0 -R CopilotKit/OpenBot --latest",
  );
  const firstDelete = calls.findIndex((call) =>
    call.startsWith("gh release delete-asset"),
  );
  expect(edit).toBeGreaterThan(-1);
  expect(firstDelete).toBeGreaterThan(edit);
  expect(repo.releaseList()).toEqual(fixture.releases);

  // A release that does not become Latest removes nothing.
  const held = repoBefore();
  held.setLatest("v1.0.3");
  held.attachFile("latest.json", JSON.stringify(feedFor("1.1.0")));
  held.attach(
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
    "OpenBot-windows-x64-setup.exe",
  );
  const kept = runScript(
    makeLatest,
    [],
    held,
    {
      RELEASE_TAG: "v1.1.0",
      MAKE_LATEST: "true",
      HOLD_LATEST: "v1.1.0",
      FEED_RETRY_DELAY: "0",
    },
    held.dir,
  );
  expect(kept.code).toBe(0);
  expect(held.calls().some((call) => call.includes("delete-asset"))).toBe(
    false,
  );
  expect(held.releaseList()).toEqual(before());
});

test("a failed removal still checks the feed, then fails the run so it is seen", () => {
  const repo = repoBefore();
  repo.setLatest("v1.0.3");
  repo.attachFile("latest.json", JSON.stringify(feedFor("1.1.0")));
  repo.attach(
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
    "OpenBot-windows-x64-setup.exe",
  );
  repo.failDeletes();
  const result = runScript(
    makeLatest,
    [],
    repo,
    { RELEASE_TAG: "v1.1.0", MAKE_LATEST: "true", FEED_RETRY_DELAY: "0" },
    repo.dir,
  );
  expect(result.code).toBe(1);
  expect(repo.latest()).toBe("v1.1.0");
  expect(result.out).toContain(
    "serves latest.json for 1.1.0, for every platform.",
  );
  expect(result.out).toContain(
    "v1.1.0 is Latest, but the installers of older releases were not all removed.",
  );
});

test("in the bucket, a run removes the older releases' installers, keeps the rest, and invalidates what it removed", () => {
  const fake = fakeDownloads();
  cleanups.push(fake.cleanup);
  fake.release("v1.1.0", { "latest.json": "{}" });
  fake.setLatest("v1.1.0");
  const object = (content: string) => ({
    content,
    cacheControl: "public, max-age=31536000, immutable",
    contentType: "application/octet-stream",
    sha256: true,
  });
  const keep = [
    "latest/OpenBot-mac-arm64.dmg",
    "latest/latest.json",
    "rollout/v1.1.1/OpenBot-mac-arm64.dmg",
    "releases/v1.1.0/OpenBot_1.1.0_aarch64.dmg",
    "releases/v1.1.0/container-images.json",
    "releases/v1.1.1-rc.1/OpenBot_1.1.1-rc.1_x64-setup.exe",
    "releases/v1.0.3/container-images.json",
    "releases/v1.0.3/desktop-images.json",
    "releases/v1.0.3/OpenBot-darwin-aarch64.app.tar.gz",
    "releases/v1.0.3/v1.0.3.tar.gz",
    "releases/nightly/OpenBot_0.0.1_aarch64.dmg",
  ];
  const remove = [
    "releases/v1.0.3/OpenBot_1.0.3_aarch64.dmg",
    "releases/v1.0.3/OpenBot_1.0.3_x64-setup.exe",
    "releases/v1.1.0-rc.2/OpenBot_1.1.0-rc.2_x64.dmg",
    "releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg",
  ];
  for (const key of [...keep, ...remove]) fake.seed(key, object(key));
  const env = { ...process.env, ...fake.env };

  const dry = Bun.spawnSync(["bash", script, "bucket", "--dry-run"], {
    env,
    cwd: root,
  });
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout.toString()).toContain(
    `Would remove s3://${BUCKET}/releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg.`,
  );
  expect(Object.keys(fake.bucket()).length).toBe(keep.length + remove.length);
  expect(fake.invalidations()).toEqual([]);

  const run = Bun.spawnSync(["bash", script, "bucket"], { env, cwd: root });
  expect(run.exitCode).toBe(0);
  expect(Object.keys(fake.bucket()).sort()).toEqual([...keep].sort());
  expect(fake.invalidations()).toEqual([
    `${DISTRIBUTION} ${remove
      .map((key) => `/${key}`)
      .sort()
      .join(" ")}`,
  ]);

  // Again: nothing left, and nothing invalidated.
  const again = Bun.spawnSync(["bash", script, "bucket"], { env, cwd: root });
  expect(again.exitCode).toBe(0);
  expect(fake.invalidations().length).toBe(1);
});

test("in the bucket, a role that may not delete objects fails loudly and invalidates nothing", () => {
  const fake = fakeDownloads();
  cleanups.push(fake.cleanup);
  fake.release("v1.1.0", { "latest.json": "{}" });
  fake.setLatest("v1.1.0");
  fake.seed("releases/v1.0.3/OpenBot_1.0.3_aarch64.dmg", {
    content: "old",
    cacheControl: "public, max-age=31536000, immutable",
    contentType: "application/x-apple-diskimage",
    sha256: true,
  });
  fake.denyDeletes();
  const result = Bun.spawnSync(["bash", script, "bucket"], {
    env: { ...process.env, ...fake.env },
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(out).toContain("AccessDenied");
  expect(out).toContain("s3:DeleteObject");
  expect(Object.keys(fake.bucket())).toEqual([
    "releases/v1.0.3/OpenBot_1.0.3_aarch64.dmg",
  ]);
  expect(fake.invalidations()).toEqual([]);
});
