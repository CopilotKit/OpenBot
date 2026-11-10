/**
 * What downloads.copilotkit.ai serves. scripts/downloads-sync.sh mirrors the Latest stable release's
 * signed installers into the bucket behind it, and runs here as the workflow runs it, against a
 * pretend `gh` and `aws` (scripts/downloads-fakes.ts). The website links to this address, so it
 * must only ever serve signed installers, and change only when a stable release becomes Latest.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUCKET,
  DISTRIBUTION,
  type FakeDownloads,
  fakeDownloads,
} from "./downloads-fakes";
import { type FakeRepo, fakeRepo, feedFor, runScript } from "./release-fakes";

const root = join(import.meta.dir, "..");
const sync = join(root, "scripts/downloads-sync.sh");
const makeLatest = join(root, "scripts/release-make-latest.sh");

// Each sync is a real bash run that starts a few hundred short processes (jq, openssl, awk and the
// fakes). On the macOS runner that is about 2.4 seconds a sync, and most tests here sync twice, so
// the 5-second default timed out the ones that did. Nothing in a sync waits on a timer or a network.
setDefaultTimeout(15_000);

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

/** A candidate as its release really carries it: signed installers and the image list, but no
 * update feed or updater archives, because a candidate is never offered as an update. */
function candidate(version: string) {
  const files: Record<string, string> = signed(version);
  delete files["latest.json"];
  delete files["OpenBot-darwin-aarch64.app.tar.gz"];
  delete files["OpenBot-darwin-aarch64.app.tar.gz.sig"];
  return files;
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
    "releases/v0.3.0/OpenBot-darwin-aarch64.app.tar.gz",
    "releases/v0.3.0/OpenBot_0.3.0_aarch64.dmg",
    "releases/v0.3.0/OpenBot_0.3.0_x64-setup.exe",
    "releases/v0.3.0/OpenBot_0.3.0_x64.dmg",
    "releases/v0.3.0/container-images.json",
  ]);
  // What the app fetches from the release besides installers, never changing.
  expect(bucket["releases/v0.3.0/container-images.json"]).toEqual({
    content: "{}",
    cacheControl: IMMUTABLE,
    contentType: "application/json",
    sha256: true,
  });
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

test("the release's full image list is served beside it, where an older app reads it to get the update ready", () => {
  // The app on the version before reads this file as soon as the update feed names the release,
  // and pulls the images it lists while it keeps running (desktop/src-tauri/src/update_ready.rs).
  // It asks this address first, so a 403 here sends every install to GitHub.
  const fake = downloads();
  const list = JSON.stringify({
    openbot: "v0.3.0",
    intelligence: "0.16.0-rc.10",
    images: ["ghcr.io/copilotkit/openbot-server@sha256:abc"],
  });
  fake.release("v0.3.0", {
    ...signed("0.3.0"),
    "desktop-images.json": list,
  });
  fake.setLatest("v0.3.0");
  expect(run(fake).code).toBe(0);
  expect(fake.bucket()["releases/v0.3.0/desktop-images.json"]).toEqual({
    content: list,
    cacheControl: IMMUTABLE,
    contentType: "application/json",
    sha256: true,
  });
  // Uploaded with the release's other files, before the feed that names the release.
  const order = puts(fake);
  expect(order.indexOf("releases/v0.3.0/desktop-images.json")).toBeLessThan(
    order.indexOf("latest/latest.json"),
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
  // Only the feed is read again, to write the mirror's copy of it and compare that.
  expect(
    again.filter((call) => call.startsWith("gh release download")),
  ).toEqual([
    "gh release download v0.3.0 -R CopilotKit/OpenBot --pattern latest.json --dir " +
      (again
        .find((call) => call.startsWith("gh release download"))
        ?.split(" --dir ")[1] ?? ""),
  ]);
  expect(fake.invalidations()).toHaveLength(1);
});

// The app updates from latest/latest.json. Its downloads must come from this address too, so the
// mirror's copy names each one where this run put it; the signatures are over the files, not their
// URLs, so they stay exactly as the signing run wrote them.
test("the mirrored feed names this address for each download it mirrors, and nothing else changes", () => {
  const fake = downloads();
  const github =
    "https://github.com/CopilotKit/OpenBot/releases/download/v0.3.0";
  // As the signing runs write it: indented, a signature per platform.
  const feed = `${JSON.stringify(
    {
      version: "0.3.0",
      notes: "See the release.",
      pub_date: "2026-11-08T00:00:00Z",
      platforms: {
        "windows-x86_64": {
          signature: "c2lnbmVkIHdpbmRvd3M=",
          url: `${github}/OpenBot_0.3.0_x64-setup.exe`,
        },
        "darwin-aarch64": {
          signature: "c2lnbmVkIGFybTY0",
          url: `${github}/OpenBot-darwin-aarch64.app.tar.gz`,
        },
        // A file this run does not mirror, and one from another release: both left as they are.
        "linux-x86_64": {
          signature: "c2lnbmVkIGxpbnV4",
          url: `${github}/OpenBot_0.3.0_amd64.AppImage`,
        },
        "darwin-x86_64": {
          signature: "c2lnbmVkIGludGVs",
          url: "https://github.com/CopilotKit/OpenBot/releases/download/v0.2.0/OpenBot-darwin-x86_64.app.tar.gz",
        },
      },
    },
    null,
    2,
  )}\n`;
  fake.release("v0.3.0", { ...signed("0.3.0"), "latest.json": feed });
  fake.setLatest("v0.3.0");
  const result = run(fake, { DOWNLOADS_VERIFY_DELAY: "0" });
  expect(result.code).toBe(0);
  const mirror = "https://downloads.copilotkit.ai/releases/v0.3.0";
  // Byte for byte the release's feed, but for the two URLs.
  expect(fake.bucket()["latest/latest.json"]).toEqual({
    content: feed
      .replace(
        `"${github}/OpenBot_0.3.0_x64-setup.exe"`,
        `"${mirror}/OpenBot_0.3.0_x64-setup.exe"`,
      )
      .replace(
        `"${github}/OpenBot-darwin-aarch64.app.tar.gz"`,
        `"${mirror}/OpenBot-darwin-aarch64.app.tar.gz"`,
      ),
    cacheControl: LATEST,
    contentType: "application/json",
    sha256: true,
  });
  const written = JSON.parse(
    fake.bucket()["latest/latest.json"]?.content ?? "{}",
  );
  expect(written.platforms["darwin-aarch64"]).toEqual({
    signature: "c2lnbmVkIGFybTY0",
    url: `${mirror}/OpenBot-darwin-aarch64.app.tar.gz`,
  });
  expect(written.platforms["linux-x86_64"].url).toBe(
    `${github}/OpenBot_0.3.0_amd64.AppImage`,
  );
  // Each named download answered through the address before the feed went up, last.
  const calls = fake.calls();
  const put = (key: string) =>
    calls.findIndex(
      (call) =>
        call.startsWith("aws s3api put-object") &&
        call.includes(`--key ${key} `),
    );
  const feedPut = put("latest/latest.json");
  for (const file of [
    "OpenBot_0.3.0_x64-setup.exe",
    "OpenBot-darwin-aarch64.app.tar.gz",
  ]) {
    const checked = calls.indexOf(
      `curl --silent --head --output /dev/null --write-out %{http_code} ${mirror}/${file}`,
    );
    expect(checked).toBeGreaterThan(put(`releases/v0.3.0/${file}`));
    expect(checked).toBeLessThan(feedPut);
  }
  expect(puts(fake).at(-1)).toBe("latest/latest.json");

  // A download the address does not serve keeps the new feed back, and says which.
  const missing = downloads();
  missing.release("v0.3.0", { ...signed("0.3.0"), "latest.json": feed });
  missing.setLatest("v0.3.0");
  missing.refuse("releases/v0.3.0/OpenBot-darwin-aarch64.app.tar.gz");
  const refused = run(missing, { DOWNLOADS_VERIFY_DELAY: "0" });
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(
    `::error::${mirror}/OpenBot-darwin-aarch64.app.tar.gz answers 403, so latest.json, which names it, was not uploaded.`,
  );
  expect(Object.keys(missing.bucket())).not.toContain("latest/latest.json");
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

test("a prerelease never touches latest/, and asked for by tag mirrors its releases/<tag>/; a draft is refused", () => {
  const fake = downloads();
  fake.release("v0.3.0", signed("0.3.0"));
  fake.release("v0.4.0-rc.1", candidate("0.4.0-rc.1"), { prerelease: true });
  fake.setLatest("v0.3.0");
  expect(run(fake).code).toBe(0);
  expect(
    Object.keys(fake.bucket()).filter((key) => key.includes("0.4.0")),
  ).toEqual([]);
  const latest = Object.fromEntries(
    Object.entries(fake.bucket()).filter(([key]) => key.startsWith("latest/")),
  );
  expect(latest["latest/OpenBot-mac-arm64.dmg"]?.content).toBe(
    "signed arm64 0.3.0",
  );

  // Asked for by name, a candidate's own files are mirrored, where its installs read them, and
  // cached for five minutes: its signing runs may still replace one. latest/ stays the stable's.
  const before = fake.calls().length;
  const result = run(fake, { DOWNLOADS_TAG: "v0.4.0-rc.1" });
  expect(result.code).toBe(0);
  expect(
    Object.keys(fake.bucket())
      .filter((key) => key.includes("0.4.0"))
      .sort(),
  ).toEqual([
    "releases/v0.4.0-rc.1/OpenBot_0.4.0-rc.1_aarch64.dmg",
    "releases/v0.4.0-rc.1/OpenBot_0.4.0-rc.1_x64-setup.exe",
    "releases/v0.4.0-rc.1/OpenBot_0.4.0-rc.1_x64.dmg",
    "releases/v0.4.0-rc.1/container-images.json",
  ]);
  expect(
    fake.bucket()["releases/v0.4.0-rc.1/OpenBot_0.4.0-rc.1_aarch64.dmg"],
  ).toMatchObject({ content: "signed arm64 0.4.0-rc.1", cacheControl: LATEST });
  expect(
    Object.fromEntries(
      Object.entries(fake.bucket()).filter(([key]) =>
        key.startsWith("latest/"),
      ),
    ),
  ).toEqual(latest);
  expect(
    fake
      .calls()
      .slice(before)
      .some(
        (call) =>
          call.includes("--key latest/") || call.startsWith("aws cloudfront"),
      ),
  ).toBe(false);

  // A draft is not published, and nothing installs it.
  fake.release("v0.5.0-rc.1", signed("0.5.0-rc.1"), {
    prerelease: true,
    draft: true,
  });
  const draft = run(fake, { DOWNLOADS_TAG: "v0.5.0-rc.1" });
  expect(draft.code).toBe(1);
  expect(draft.out).toContain(
    "::error::v0.5.0-rc.1 is a draft, not a published release. Nothing was mirrored.",
  );
  expect(Object.keys(fake.bucket()).some((key) => key.includes("0.5.0"))).toBe(
    false,
  );
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
    "releases/v0.2.0/OpenBot-darwin-aarch64.app.tar.gz",
    "releases/v0.2.0/OpenBot_0.2.0_aarch64.dmg",
    "releases/v0.2.0/OpenBot_0.2.0_x64-setup.exe",
    "releases/v0.2.0/OpenBot_0.2.0_x64.dmg",
    "releases/v0.2.0/container-images.json",
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
  const complete = (fake: FakeRepo) => {
    fake.attachFile("latest.json", JSON.stringify(feedFor("0.3.0")));
    fake.attach(
      "OpenBot-mac-arm64.dmg",
      "OpenBot-mac-x64.dmg",
      "OpenBot-windows-x64-setup.exe",
    );
  };
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
  const runs = job.steps?.map((step) => step.run).filter(Boolean);
  // The images first: a failed copy stops the job before latest/ names the release.
  expect(runs?.at(-2)).toBe("bun scripts/downloads-images.ts");
  expect(runs?.at(-1)).toBe("scripts/downloads-sync.sh");

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
