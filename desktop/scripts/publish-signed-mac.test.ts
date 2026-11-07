/**
 * The Mac signing run's publish job, run as the workflow runs it, against a pretend `gh` and
 * `curl` (scripts/release-fakes.ts).
 */
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type FakeRepo,
  fakeRepo,
  feedFor,
  runScript,
} from "../../scripts/release-fakes";

const root = join(import.meta.dir, "../..");
const script = join(root, "desktop/scripts/publish-signed-mac.sh");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A job folder holding the signing artifacts of `version`, as download-artifact leaves them. */
function job(version: string, pinned?: string) {
  const dir = mkdtempSync(join(tmpdir(), "publish-signed-mac-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const artifacts = join(dir, "artifacts");
  mkdirSync(artifacts);
  writeFileSync(
    join(artifacts, "build-version.json"),
    JSON.stringify({
      version,
      channel: "release",
      ...(pinned ? { pinned } : {}),
    }),
  );
  writeFileSync(join(artifacts, `OpenBot_${version}_aarch64.dmg`), "signed");
  writeFileSync(join(artifacts, `OpenBot_${version}_x64.dmg`), "signed");
  if (!pinned) {
    for (const target of ["darwin-aarch64", "darwin-x86_64"]) {
      writeFileSync(join(artifacts, `OpenBot-${target}.app.tar.gz`), "archive");
      writeFileSync(
        join(artifacts, `OpenBot-${target}.app.tar.gz.sig`),
        `sig-${target}`,
      );
    }
  }
  return dir;
}

function repo(latest: string): FakeRepo {
  const fake = fakeRepo(latest);
  cleanups.push(fake.cleanup);
  return fake;
}

function publish(fake: FakeRepo, dir: string, tag: string, makeLatest: string) {
  return runScript(
    script,
    [],
    fake,
    {
      RELEASE_TAG: tag,
      MAKE_LATEST: makeLatest,
      ARTIFACTS: "artifacts",
      FEED_RETRY_DELAY: "0",
      RUNNER_TEMP: dir,
    },
    dir,
  );
}

/** The asset names one `gh release upload` call attaches. */
function names(call: string) {
  return call
    .split(" ")
    .slice(6)
    .filter((arg) => arg !== "--clobber")
    .map((path) => basename(path));
}

/** What Windows signing leaves on the release when it ran first: its installer, listed. */
function windowsSigned(fake: FakeRepo, version: string) {
  fake.attach(
    `OpenBot_${version}_x64-setup.exe`,
    "OpenBot-windows-x64-setup.exe",
  );
  fake.attachFile(
    "latest.json",
    JSON.stringify(feedFor(version, ["windows-x86_64"])),
  );
}

// The run that went red on every candidate, after replacing its pinned installer.
test("a candidate attaches its pinned .dmg files only, and is not checked against the feed", () => {
  const fake = repo("v0.2.0");
  const dir = job("0.3.0-rc.1", "v0.3.0-rc.1");
  const result = publish(fake, dir, "v0.3.0-rc.1", "false");
  expect(result.code).toBe(0);
  const calls = fake.calls();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe("gh release view v0.3.0-rc.1 -R CopilotKit/OpenBot");
  expect(calls[1]).toStartWith(
    "gh release upload v0.3.0-rc.1 -R CopilotKit/OpenBot artifacts/OpenBot_0.3.0-rc.1_aarch64.dmg artifacts/OpenBot_0.3.0-rc.1_x64.dmg ",
  );
  // The fixed download names, in the same upload, so the stable links serve the signed build.
  expect(names(calls[1] as string)).toEqual([
    "OpenBot_0.3.0-rc.1_aarch64.dmg",
    "OpenBot_0.3.0-rc.1_x64.dmg",
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
  ]);
  expect(existsSync(join(dir, "latest.json"))).toBe(false);
  expect(fake.latest()).toBe("v0.2.0");
});

test("a build pinned to another release is not attached", () => {
  const fake = repo("v0.2.0");
  const dir = job("0.3.0-rc.1", "v0.3.0-rc.2");
  const result = publish(fake, dir, "v0.3.0-rc.1", "false");
  expect(result.code).toBe(1);
  expect(fake.calls().some((call) => call.includes("upload"))).toBe(false);
});

test("a build of another version is not attached", () => {
  const fake = repo("v0.2.0");
  const dir = job("0.3.1", undefined);
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(1);
  expect(result.out).toContain("The signed build is version 0.3.1, not 0.3.0.");
  expect(fake.calls()).toEqual([]);
});

// The gap where Mac signing made a release Latest while its Windows link still served the unsigned
// installer: Latest waits for the signed Windows one as well.
test("a stable release signed on Mac before Windows is not Latest yet, so its Windows link never serves the unsigned installer", () => {
  const fake = repo("v0.2.0");
  fake.attach("OpenBot_0.3.0_x64-setup.exe");
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "v0.3.0 is not Latest yet: it still needs the signed OpenBot-windows-x64-setup.exe.",
  );
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.calls().some((call) => call.startsWith("curl"))).toBe(false);
  expect(fake.latest()).toBe("v0.2.0");
});

// A stable release is published not Latest; it becomes Latest in the signing run that attaches
// the last signed installer, here when Windows signing finished first.
test("a stable release becomes Latest only after its signed installers are attached, then its feed is checked", () => {
  const fake = repo("v0.2.0");
  windowsSigned(fake, "0.3.0");
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "serves latest.json for 0.3.0, for every platform.",
  );
  const calls = fake.calls();
  const uploads = calls.filter((call) => call.startsWith("gh release upload"));
  expect(uploads).toHaveLength(3);
  expect(uploads[0]).toContain("OpenBot-darwin-x86_64.app.tar.gz.sig");
  expect(names(uploads[1] as string)).toEqual([
    "OpenBot_0.3.0_aarch64.dmg",
    "OpenBot_0.3.0_x64.dmg",
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
  ]);
  // The feed last, once every file it names is on the release.
  expect(names(uploads[2] as string)).toEqual(["latest.json"]);
  const promote = calls.indexOf(
    "gh release edit v0.3.0 -R CopilotKit/OpenBot --latest",
  );
  expect(promote).toBeGreaterThan(calls.lastIndexOf(uploads[2] as string));
  expect(fake.latest()).toBe("v0.3.0");
  expect(calls.at(-1)).toContain(
    "curl -fsSL --retry 3 https://github.com/CopilotKit/OpenBot/releases/latest/download/latest.json",
  );
});

test("latest.json names both Mac archives with their real signatures, and keeps the Windows installer", () => {
  const fake = repo("v0.2.0");
  windowsSigned(fake, "0.3.0");
  const dir = job("0.3.0");
  expect(publish(fake, dir, "v0.3.0", "false").code).toBe(0);
  const feed = JSON.parse(fake.file("latest.json"));
  expect(feed.version).toBe("0.3.0");
  expect(feed.platforms).toEqual({
    "darwin-aarch64": {
      url: "https://github.com/CopilotKit/OpenBot/releases/download/v0.3.0/OpenBot-darwin-aarch64.app.tar.gz",
      signature: "sig-darwin-aarch64",
    },
    "darwin-x86_64": {
      url: "https://github.com/CopilotKit/OpenBot/releases/download/v0.3.0/OpenBot-darwin-x86_64.app.tar.gz",
      signature: "sig-darwin-x86_64",
    },
    "windows-x86_64": feedFor("0.3.0").platforms["windows-x86_64"],
  });
});

// The installers alone were enough before, and the release became Latest with a feed that
// listed no Windows installer, so Windows apps were never offered it.
test("a stable release whose feed does not list Windows yet is not Latest", () => {
  const fake = repo("v0.2.0");
  fake.attach("OpenBot_0.3.0_x64-setup.exe", "OpenBot-windows-x64-setup.exe");
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "v0.3.0 is not Latest yet: it still needs the signed windows-x86_64 in latest.json.",
  );
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.latest()).toBe("v0.2.0");
});

test("a stable release does not take Latest from a newer one that became Latest meanwhile", () => {
  const fake = repo("v0.4.0");
  windowsSigned(fake, "0.3.1");
  const dir = job("0.3.1");
  const result = publish(fake, dir, "v0.3.1", "true");
  expect(result.code).toBe(0);
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.calls().some((call) => call.startsWith("curl"))).toBe(false);
  expect(fake.latest()).toBe("v0.4.0");
  expect(result.out).toContain("not the latest release");
});

test("signing again by hand leaves Latest where it is", () => {
  const fake = repo("v0.2.0");
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "false");
  expect(result.code).toBe(0);
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.latest()).toBe("v0.2.0");
});

test("signing the current Latest again checks its feed", () => {
  const fake = repo("v0.3.0");
  windowsSigned(fake, "0.3.0");
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "false");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "serves latest.json for 0.3.0, for every platform.",
  );
});

test("a Latest release whose feed leaves Windows out fails the feed check", () => {
  const fake = repo("v0.3.0");
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "false");
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "does not serve a latest.json with version 0.3.0 and a signed file for every platform (darwin-aarch64 darwin-x86_64 windows-x86_64)",
  );
});

test("a Latest release whose feed names another version fails", () => {
  const fake = repo("v0.2.0");
  windowsSigned(fake, "0.3.0");
  fake.feed("v0.3.0", feedFor("0.2.0"));
  const dir = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "does not serve a latest.json with version 0.3.0",
  );
});

test("a signed image with no fixed download name is not attached", () => {
  const fake = repo("v0.2.0");
  const dir = job("0.3.0");
  writeFileSync(join(dir, "artifacts/OpenBot_0.3.0_universal.dmg"), "signed");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "is not an installer with a fixed download name",
  );
  expect(fake.calls().some((call) => call.includes("upload"))).toBe(false);
});
