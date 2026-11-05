/**
 * What downloads.copilotkit.ai serves. scripts/downloads-sync.sh mirrors the Latest stable release's
 * signed installers into the bucket behind it, and runs here as the workflow runs it, against a
 * pretend `gh` and `aws` (scripts/downloads-fakes.ts). The website links to this address, so it
 * must only ever serve signed installers, and change only when a stable release becomes Latest.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUCKET,
  DISTRIBUTION,
  type FakeDownloads,
  fakeDownloads,
} from "./downloads-fakes";
import { type FakeRepo, fakeRepo, runScript } from "./release-fakes";

const root = join(import.meta.dir, "..");
const sync = join(root, "scripts/downloads-sync.sh");
const makeLatest = join(root, "scripts/release-make-latest.sh");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function downloads(): FakeDownloads {
  const fake = fakeDownloads();
  cleanups.push(fake.cleanup);
  return fake;
}

/** A stable release as the signing runs leave it: each installer signed, under both names. */
function signed(version: string) {
  return {
    [`OpenBot_${version}_aarch64.dmg`]: `signed arm64 ${version}`,
    [`OpenBot_${version}_x64.dmg`]: `signed x64 ${version}`,
    [`OpenBot_${version}_x64-setup.exe`]: `signed windows ${version}`,
    "OpenBot-mac-arm64.dmg": `signed arm64 ${version}`,
    "OpenBot-mac-x64.dmg": `signed x64 ${version}`,
    "OpenBot-windows-x64-setup.exe": `signed windows ${version}`,
    "latest.json": JSON.stringify({ version }),
    "OpenBot-darwin-aarch64.app.tar.gz": "updater archive",
    "OpenBot-darwin-aarch64.app.tar.gz.sig": "updater signature",
    "container-images.json": "{}",
  };
}

function run(fake: FakeDownloads, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", sync], {
    cwd: root,
    env: { ...process.env, ...fake.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

const puts = (fake: FakeDownloads) =>
  fake
    .calls()
    .filter((call) => call.startsWith("aws s3api put-object"))
    .map((call) => call.split(" --key ")[1]?.split(" ")[0]);

const LATEST = "public, max-age=300";
const IMMUTABLE = "public, max-age=31536000, immutable";

test("the first sync copies every signed installer and latest.json, and invalidates /latest/*", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  const result = run(fake);
  expect(result.code).toBe(0);
  const bucket = fake.bucket();
  expect(Object.keys(bucket).sort()).toEqual([
    "latest/OpenBot-mac-arm64.dmg",
    "latest/OpenBot-mac-x64.dmg",
    "latest/OpenBot-windows-x64-setup.exe",
    "latest/latest.json",
    "releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg",
    "releases/v0.3.0/OpenBot_0.3.0_x64-setup.exe",
    "releases/v0.3.0/OpenBot_0.3.0_x64.dmg",
  ]);
  expect(bucket["latest/OpenBot-mac-arm64.dmg"]).toEqual({
    content: "signed arm64 0.3.0",
    cacheControl: LATEST,
    contentType: "application/x-apple-diskimage",
    sha256: true,
  });
  expect(bucket["latest/OpenBot-windows-x64-setup.exe"]).toMatchObject({
    content: "signed windows 0.3.0",
    cacheControl: LATEST,
    contentType: "application/vnd.microsoft.portable-executable",
  });
  expect(bucket["latest/latest.json"]).toMatchObject({
    content: '{"version":"0.3.0"}',
    cacheControl: LATEST,
    contentType: "application/json",
  });
  expect(bucket["releases/v0.3.0/OpenBot_0.3.0_x64.dmg"]).toMatchObject({
    content: "signed x64 0.3.0",
    cacheControl: IMMUTABLE,
  });
  // latest.json last, after the installers it describes; then one invalidation.
  expect(puts(fake).at(-1)).toBe("latest/latest.json");
  expect(fake.invalidations()).toEqual([`${DISTRIBUTION} /latest/*`]);
  const calls = fake.calls();
  expect(
    calls.findIndex((call) => call.startsWith("aws cloudfront")),
  ).toBeGreaterThan(
    calls.findLastIndex((call) => call.startsWith("aws s3api put-object")),
  );
});

test("a second sync with nothing new uploads nothing and does not invalidate", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  expect(run(fake).code).toBe(0);
  const before = fake.calls().length;
  const result = run(fake);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "downloads.copilotkit.ai already serves v0.3.0. Nothing to upload.",
  );
  const again = fake.calls().slice(before);
  expect(again.some((call) => call.startsWith("aws s3api put-object"))).toBe(
    false,
  );
  expect(again.some((call) => call.startsWith("gh release download"))).toBe(
    false,
  );
  expect(fake.invalidations()).toHaveLength(1);
});

test("drift in S3 is repaired, and only what drifted is uploaded", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  expect(run(fake).code).toBe(0);
  // Someone put an ad-hoc build over the Intel link by hand, a release file went missing, the
  // feed lost its caching header, and the Windows link was re-uploaded from the console with the
  // same bytes but no SHA-256 for S3 to compare.
  fake.seed("latest/OpenBot-mac-x64.dmg", {
    content: "ad-hoc x64",
    cacheControl: LATEST,
    contentType: "application/x-apple-diskimage",
    sha256: true,
  });
  fake.remove("releases/v0.3.0/OpenBot_0.3.0_x64-setup.exe");
  fake.seed("latest/latest.json", {
    content: '{"version":"0.3.0"}',
    cacheControl: "",
    contentType: "application/json",
    sha256: true,
  });
  fake.seed("latest/OpenBot-windows-x64-setup.exe", {
    content: "signed windows 0.3.0",
    cacheControl: LATEST,
    contentType: "application/vnd.microsoft.portable-executable",
    sha256: false,
  });
  const before = fake.calls().length;
  const result = run(fake);
  expect(result.code).toBe(0);
  const repaired = fake
    .calls()
    .slice(before)
    .filter((call) => call.startsWith("aws s3api put-object"))
    .map((call) => call.split(" --key ")[1]?.split(" ")[0]);
  expect(repaired).toEqual([
    "releases/v0.3.0/OpenBot_0.3.0_x64-setup.exe",
    "latest/OpenBot-mac-x64.dmg",
    "latest/OpenBot-windows-x64-setup.exe",
    "latest/latest.json",
  ]);
  const bucket = fake.bucket();
  expect(bucket["latest/OpenBot-mac-x64.dmg"]?.content).toBe(
    "signed x64 0.3.0",
  );
  expect(bucket["latest/latest.json"]?.cacheControl).toBe(LATEST);
  expect(bucket["latest/OpenBot-windows-x64-setup.exe"]?.sha256).toBe(true);
  expect(bucket["releases/v0.3.0/OpenBot_0.3.0_x64-setup.exe"]?.content).toBe(
    "signed windows 0.3.0",
  );
  expect(fake.invalidations()).toHaveLength(2);
});

test("a newer stable release replaces latest/ and keeps the older one's releases/ folder", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  expect(run(fake).code).toBe(0);
  fake.release("v0.4.0", signed("0.4.0"));
  fake.setLatest("v0.4.0");
  expect(run(fake).code).toBe(0);
  const bucket = fake.bucket();
  expect(bucket["latest/OpenBot-mac-arm64.dmg"]?.content).toBe(
    "signed arm64 0.4.0",
  );
  expect(bucket["releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg"]?.content).toBe(
    "signed arm64 0.3.0",
  );
  expect(bucket["releases/v0.4.0/OpenBot_0.4.0_aarch64.dmg"]?.content).toBe(
    "signed arm64 0.4.0",
  );
  expect(fake.invalidations()).toHaveLength(2);
});

// Windows signing has not attached its installer yet, so the release has no signed Windows link.
test("a release missing a signed installer changes nothing and fails", () => {
  const fake = downloads();
  const assets: Record<string, string> = signed("0.3.0");
  delete assets["OpenBot-windows-x64-setup.exe"];
  fake.release("v0.3.0", assets);
  fake.setLatest("v0.3.0");
  const result = run(fake);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "v0.3.0 does not have the signed OpenBot-windows-x64-setup.exe yet, so nothing was mirrored.",
  );
  expect(fake.bucket()).toEqual({});
  expect(fake.invalidations()).toEqual([]);
  expect(
    fake
      .calls()
      .some(
        (call) =>
          call.startsWith("aws ") || call.startsWith("gh release download"),
      ),
  ).toBe(false);
});

/** A stable release published before signing attached anything, as v0.2.0 was. */
function unsigned(version: string) {
  return {
    [`OpenBot_${version}_aarch64.dmg`]: `ad-hoc arm64 ${version}`,
    [`OpenBot_${version}_x64-setup.exe`]: `unsigned windows ${version}`,
    "container-images.json": "{}",
  };
}

// The schedule must not fail on main every six hours while Latest predates signed releases.
test("a Latest release with no signed installers at all is not drift: nothing to sync, no AWS calls, success", () => {
  const fake = downloads();
  fake.release("v0.2.0", unsigned("0.2.0"));
  fake.setLatest("v0.2.0");
  const result = run(fake);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "Latest release v0.2.0 has no signed installers yet; nothing to sync.",
  );
  expect(result.out).not.toContain("::error::");
  expect(fake.calls().some((call) => call.startsWith("aws "))).toBe(false);
  expect(
    fake.calls().some((call) => call.startsWith("gh release download")),
  ).toBe(false);
  expect(fake.bucket()).toEqual({});
  expect(fake.invalidations()).toEqual([]);
});

// Half-signed: one signing run attached its files and the other did not, or someone removed one.
test("a Latest release with some but not all signed files fails and changes nothing", () => {
  for (const present of [
    ["OpenBot-windows-x64-setup.exe"],
    ["latest.json"],
    ["latest.json", "OpenBot-mac-arm64.dmg", "OpenBot-mac-x64.dmg"],
  ]) {
    const fake = downloads();
    const all = signed("0.3.0") as Record<string, string>;
    const assets: Record<string, string> = unsigned("0.3.0");
    for (const name of present) assets[name] = all[name] as string;
    fake.release("v0.3.0", assets);
    fake.setLatest("v0.3.0");
    const result = run(fake);
    expect(result.code).toBe(1);
    expect(result.out).toContain("::error::v0.3.0 does not have the signed");
    expect(fake.calls().some((call) => call.startsWith("aws "))).toBe(false);
    expect(fake.bucket()).toEqual({});
  }
});

test("a release asked for by tag with no signed installers at all fails and changes nothing", () => {
  const fake = downloads();
  fake.release("v0.2.0", unsigned("0.2.0"));
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  const result = run(fake, { DOWNLOADS_TAG: "v0.2.0" });
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "::error::v0.2.0 does not have the signed latest.json OpenBot-mac-arm64.dmg OpenBot-mac-x64.dmg OpenBot-windows-x64-setup.exe yet",
  );
  expect(fake.calls().some((call) => call.startsWith("aws "))).toBe(false);
  expect(fake.bucket()).toEqual({});
});

test("a release with no latest.json, or whose versioned installer is not the signed one, changes nothing and fails", () => {
  const noFeed = downloads();
  const assets: Record<string, string> = signed("0.3.0");
  delete assets["latest.json"];
  noFeed.release("v0.3.0", assets);
  noFeed.setLatest("v0.3.0");
  const result = run(noFeed);
  expect(result.code).toBe(1);
  expect(result.out).toContain("does not have the signed latest.json yet");
  expect(noFeed.bucket()).toEqual({});

  const unsigned = downloads();
  unsigned.release("v0.3.0", {
    ...signed("0.3.0"),
    "OpenBot_0.3.0_x64-setup.exe": "unsigned windows 0.3.0",
  });
  unsigned.setLatest("v0.3.0");
  const mismatch = run(unsigned);
  expect(mismatch.code).toBe(1);
  expect(mismatch.out).toContain(
    "OpenBot_0.3.0_x64-setup.exe on v0.3.0 is not the signed build attached as OpenBot-windows-x64-setup.exe",
  );
  expect(unsigned.bucket()).toEqual({});
  expect(unsigned.invalidations()).toEqual([]);
});

test("prereleases are ignored, even fully signed and newer than Latest", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.release("v0.4.0-rc.1", signed("0.4.0-rc.1"), { prerelease: true });
  fake.setLatest("v0.3.0");
  expect(run(fake).code).toBe(0);
  expect(
    Object.keys(fake.bucket()).filter((key) => key.includes("0.4.0")),
  ).toEqual([]);
  expect(fake.bucket()["latest/OpenBot-mac-arm64.dmg"]?.content).toBe(
    "signed arm64 0.3.0",
  );

  // Asked for by name, a candidate is refused and nothing changes.
  const before = fake.calls().length;
  const result = run(fake, { DOWNLOADS_TAG: "v0.4.0-rc.1" });
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "v0.4.0-rc.1 is a prerelease, a draft or a candidate, not a stable release. Nothing was mirrored.",
  );
  expect(
    fake
      .calls()
      .slice(before)
      .some((call) => call.startsWith("aws ")),
  ).toBe(false);
});

test("a candidate tag is refused even when it is not marked a prerelease", () => {
  const fake = downloads();
  fake.release("v0.4.0-rc.1", signed("0.4.0-rc.1"));
  fake.setLatest("v0.4.0-rc.1");
  const result = run(fake);
  expect(result.code).toBe(1);
  expect(fake.bucket()).toEqual({});
});

test("a tag mirrors that stable release's releases/<tag>/ only, and leaves latest/ alone", () => {
  const fake = downloads();
  fake.release("v0.2.0", signed("0.2.0"));
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  const result = run(fake, { DOWNLOADS_TAG: "v0.2.0" });
  expect(result.code).toBe(0);
  expect(Object.keys(fake.bucket()).sort()).toEqual([
    "releases/v0.2.0/OpenBot_0.2.0_aarch64.dmg",
    "releases/v0.2.0/OpenBot_0.2.0_x64-setup.exe",
    "releases/v0.2.0/OpenBot_0.2.0_x64.dmg",
  ]);
  expect(fake.invalidations()).toEqual([]);
});

test("a scratch prefix keeps every key, and the invalidation, under it", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  expect(run(fake, { DOWNLOADS_PREFIX: "smoketest/" }).code).toBe(0);
  expect(
    Object.keys(fake.bucket()).every((key) => key.startsWith("smoketest/")),
  ).toBe(true);
  expect(fake.invalidations()).toEqual([`${DISTRIBUTION} /smoketest/latest/*`]);
  expect(run(fake, { DOWNLOADS_PREFIX: "latest" }).code).toBe(1);
});

test("an S3 error other than a missing object stops the sync before anything is uploaded", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.setLatest("v0.3.0");
  fake.deny();
  const result = run(fake);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    `Could not read s3://${BUCKET}/releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg`,
  );
  expect(result.out).toContain("(403)");
  expect(puts(fake)).toEqual([]);
  expect(fake.invalidations()).toEqual([]);
});

// Making a stable release Latest edits the release with the workflow's token, and an edit made
// with that token starts no workflow. The sync is dispatched instead, which does.
test("making a stable release Latest dispatches the sync, and nothing else does", () => {
  const complete = (fake: FakeRepo) =>
    fake.attach(
      "latest.json",
      "OpenBot-mac-arm64.dmg",
      "OpenBot-mac-x64.dmg",
      "OpenBot-windows-x64-setup.exe",
    );
  const promote = (fake: FakeRepo, makeLatestFlag = "true") =>
    runScript(
      makeLatest,
      [],
      fake,
      {
        RELEASE_TAG: "v0.3.0",
        MAKE_LATEST: makeLatestFlag,
        FEED_RETRY_DELAY: "0",
      },
      // The feed check writes feed.json where it runs.
      fake.dir,
    );
  const dispatch =
    "gh workflow run downloads-sync.yml -R CopilotKit/OpenBot --ref main";

  const fake = fakeRepo("v0.2.0");
  cleanups.push(fake.cleanup);
  complete(fake);
  fake.feed("v0.3.0", {
    version: "0.3.0",
    platforms: {
      "darwin-aarch64": { url: "https://example.test/a", signature: "s" },
    },
  });
  const result = promote(fake);
  expect(result.code).toBe(0);
  const calls = fake.calls();
  expect(calls.indexOf(dispatch)).toBe(
    calls.indexOf("gh release edit v0.3.0 -R CopilotKit/OpenBot --latest") + 1,
  );

  // Still waiting for a signed installer: not Latest, and nothing to mirror.
  const waiting = fakeRepo("v0.2.0");
  cleanups.push(waiting.cleanup);
  waiting.attach("latest.json", "OpenBot-mac-arm64.dmg", "OpenBot-mac-x64.dmg");
  expect(promote(waiting).code).toBe(0);
  expect(waiting.calls()).not.toContain(dispatch);

  // A newer release is Latest already.
  const newer = fakeRepo("v0.4.0");
  cleanups.push(newer.cleanup);
  complete(newer);
  expect(promote(newer).code).toBe(0);
  expect(newer.calls()).not.toContain(dispatch);

  // Signed again by hand, without asking for Latest.
  const byHand = fakeRepo("v0.2.0");
  cleanups.push(byHand.cleanup);
  complete(byHand);
  expect(promote(byHand, "false").code).toBe(0);
  expect(byHand.calls()).not.toContain(dispatch);
  // Four runs of the script, each spawning several processes.
}, 20_000);

type Job = {
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: { uses?: string; with?: Record<string, string>; run?: string }[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};
const workflow = (path: string) =>
  Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as Workflow;

test("the sync workflow runs on main only, one at a time, with the role and nothing more", () => {
  const sync = workflow(".github/workflows/downloads-sync.yml");
  expect(Object.keys(sync.on).sort()).toEqual([
    "schedule",
    "workflow_dispatch",
  ]);
  expect(sync.on.schedule).toEqual([{ cron: "17 */6 * * *" }]);
  expect(sync.concurrency).toEqual({
    group: "downloads-sync",
    "cancel-in-progress": false,
  });
  expect(sync.permissions).toEqual({});
  const job = sync.jobs.sync as Job;
  expect(job.if).toBe("github.repository == 'CopilotKit/OpenBot'");
  expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(job.env?.DOWNLOADS_BUCKET).toBe("copilotkit-openbot-downloads");
  expect(job.env?.DOWNLOADS_DISTRIBUTION_ID).toBe("EQ4EH8L79LPGX");
  const login = job.steps?.find((step) =>
    step.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  expect(login?.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(login?.with?.["role-to-assume"]).toBe(
    "arn:aws:iam::604598162673:role/openbot-release-downloads",
  );
  expect(job.steps?.at(-1)?.run).toBe("scripts/downloads-sync.sh");

  // Both attach jobs may be the one that makes the release Latest, so both may start the sync.
  for (const path of [
    ".github/workflows/desktop-macos-signing.yml",
    ".github/workflows/desktop-signing.yml",
  ]) {
    expect(workflow(path).jobs.publish?.permissions).toEqual({
      contents: "write",
      actions: "write",
    });
  }
});
