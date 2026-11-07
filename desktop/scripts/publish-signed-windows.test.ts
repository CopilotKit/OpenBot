/**
 * The Windows signing run's publish job, run as the workflow runs it, against a pretend `gh`
 * (scripts/release-fakes.ts).
 */
import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type FakeRepo,
  feedFor,
  fakeRepo,
  runScript,
} from "../../scripts/release-fakes";

const root = join(import.meta.dir, "../..");
const script = join(root, "desktop/scripts/publish-signed-windows.sh");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A job folder holding the signing artifact of `version`, laid out as upload-artifact keeps it,
 * with the sign-update job's updater signature beside the installer unless the build is pinned or
 * `signature` is false.
 */
function job(version: string, pinned?: string, signature = !pinned) {
  const dir = mkdtempSync(join(tmpdir(), "publish-signed-windows-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const artifacts = join(dir, "artifacts");
  const nsis = join(artifacts, "src-tauri/target/release/bundle/nsis");
  mkdirSync(nsis, { recursive: true });
  mkdirSync(join(artifacts, "signed-app"));
  writeFileSync(
    join(artifacts, "build-version.json"),
    JSON.stringify({
      version,
      channel: "release",
      ...(pinned ? { pinned } : {}),
    }),
  );
  writeFileSync(join(nsis, `OpenBot_${version}_x64-setup.exe`), "signed");
  if (signature) {
    writeFileSync(
      join(nsis, `OpenBot_${version}_x64-setup.exe.sig`),
      "sig-windows",
    );
  }
  writeFileSync(join(artifacts, "signed-app/openbot-desktop.exe"), "app");
  return { dir, nsis };
}

function repo(): FakeRepo {
  const fake = fakeRepo("v0.2.0");
  cleanups.push(fake.cleanup);
  return fake;
}

function publish(fake: FakeRepo, dir: string, tag: string, makeLatest = "") {
  return runScript(
    script,
    [],
    fake,
    {
      RELEASE_TAG: tag,
      MAKE_LATEST: makeLatest,
      ARTIFACTS: "artifacts",
      RUNNER_TEMP: dir,
      FEED_RETRY_DELAY: "0",
    },
    dir,
  );
}

/** What each upload would attach, as "<asset name>=<content>". */
function uploads(fake: FakeRepo, dir: string) {
  return fake
    .calls()
    .filter((call) => call.startsWith("gh release upload "))
    .flatMap((call) =>
      call
        .split(" ")
        .slice(6)
        .filter((arg) => arg !== "--clobber")
        .map((path) => {
          const file = path.startsWith("/") ? path : join(dir, path);
          return `${basename(path)}=${readFileSync(file, "utf8")}`;
        }),
    );
}

test("a stable release gets the signed installer under its own name and its fixed name, and its updater signature, in one upload", () => {
  const fake = repo();
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0");
  expect(result.code).toBe(0);
  expect(fake.calls()[0]).toBe("gh release view v0.3.0 -R CopilotKit/OpenBot");
  expect(fake.calls()[1]).toStartWith("gh release upload v0.3.0 ");
  expect(fake.calls()[1]).toEndWith(" --clobber");
  expect(uploads(fake, dir)).toEqual([
    "OpenBot_0.3.0_x64-setup.exe=signed",
    "OpenBot-windows-x64-setup.exe=signed",
    "OpenBot_0.3.0_x64-setup.exe.sig=sig-windows",
    `latest.json=${fake.file("latest.json")}`,
  ]);
});

// Before, a Windows app could never be offered an update: latest.json listed the Mac archives
// alone. The installer the updater runs on Windows is the signed -setup.exe itself.
test("a stable release lists its signed installer in latest.json for Windows", () => {
  const fake = repo();
  const { dir } = job("0.3.0");
  expect(publish(fake, dir, "v0.3.0").code).toBe(0);
  const feed = JSON.parse(fake.file("latest.json"));
  expect(feed.version).toBe("0.3.0");
  expect(feed.platforms).toEqual({
    "windows-x86_64": {
      url: "https://github.com/CopilotKit/OpenBot/releases/download/v0.3.0/OpenBot_0.3.0_x64-setup.exe",
      signature: "sig-windows",
    },
  });
  // The same changelog section the Mac run writes, and a date the updater can read.
  expect(feed.notes.length).toBeGreaterThan(0);
  expect(new Date(feed.pub_date).toISOString()).toBe(
    feed.pub_date.replace("Z", ".000Z"),
  );
});

// Whichever signing run finishes second must leave a feed that lists both, or one platform's apps
// would never be offered the release.
test("Windows signing keeps the Mac archives Mac signing already listed", () => {
  const fake = repo();
  fake.attachFile(
    "latest.json",
    JSON.stringify({
      ...feedFor("0.3.0", ["darwin-aarch64", "darwin-x86_64"]),
      notes: "mac",
    }),
  );
  const { dir } = job("0.3.0");
  expect(publish(fake, dir, "v0.3.0").code).toBe(0);
  const feed = JSON.parse(fake.file("latest.json"));
  expect(Object.keys(feed.platforms).sort()).toEqual([
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
  ]);
  expect(feed.platforms["darwin-x86_64"]).toEqual(
    feedFor("0.3.0").platforms["darwin-x86_64"],
  );
});

test("a feed left from another version keeps none of its platforms", () => {
  const fake = repo();
  fake.attachFile("latest.json", JSON.stringify(feedFor("0.2.9")));
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0");
  expect(result.code).toBe(0);
  expect(result.out).toContain("describes version 0.2.9, not 0.3.0");
  expect(Object.keys(JSON.parse(fake.file("latest.json")).platforms)).toEqual([
    "windows-x86_64",
  ]);
});

test("an installer the updater could not verify is not attached", () => {
  const fake = repo();
  const { dir } = job("0.3.0", undefined, false);
  const result = publish(fake, dir, "v0.3.0");
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "OpenBot_0.3.0_x64-setup.exe has no updater signature in artifacts.",
  );
  expect(fake.calls().some((call) => call.includes("upload"))).toBe(false);
});

// The workflow downloads the sign-update job's artifact into a folder of its own.
test("the updater signature is found where the sign-update job's artifact was downloaded", () => {
  const fake = repo();
  const { dir } = job("0.3.0", undefined, false);
  mkdirSync(join(dir, "artifacts/updater-signature"));
  writeFileSync(
    join(dir, "artifacts/updater-signature/OpenBot_0.3.0_x64-setup.exe.sig"),
    "sig-windows",
  );
  expect(publish(fake, dir, "v0.3.0").code).toBe(0);
  expect(uploads(fake, dir)).toContain(
    "OpenBot_0.3.0_x64-setup.exe.sig=sig-windows",
  );
  expect(
    JSON.parse(fake.file("latest.json")).platforms["windows-x86_64"].signature,
  ).toBe("sig-windows");
});

test("signing again by hand never moves Latest", () => {
  const fake = repo();
  const { dir } = job("0.3.0");
  expect(publish(fake, dir, "v0.3.0").code).toBe(0);
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.latest()).toBe("v0.2.0");
});

// The gap where Mac signing made a release Latest while this link still served the unsigned
// installer: whichever signing run attaches the last signed installer makes the release Latest.
test("Windows signing that finishes after Mac signing makes the release Latest, then checks its feed", () => {
  const fake = repo();
  fake.attachFile(
    "latest.json",
    JSON.stringify(feedFor("0.3.0", ["darwin-aarch64", "darwin-x86_64"])),
  );
  fake.attach(
    "OpenBot_0.3.0_aarch64.dmg",
    "OpenBot_0.3.0_x64.dmg",
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
  );
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  const calls = fake.calls();
  const feedUpload = calls.reduce(
    (last, call, index) =>
      call.startsWith(
        "gh release upload v0.3.0 -R CopilotKit/OpenBot latest.json",
      )
        ? index
        : last,
    -1,
  );
  const promote = calls.indexOf(
    "gh release edit v0.3.0 -R CopilotKit/OpenBot --latest",
  );
  expect(feedUpload).toBeGreaterThan(0);
  expect(promote).toBeGreaterThan(feedUpload);
  expect(fake.latest()).toBe("v0.3.0");
  // What the apps read now lists the Mac archives and this installer.
  expect(result.out).toContain(
    "serves latest.json for 0.3.0, for every platform.",
  );
});

test("Windows signing that finishes before Mac signing leaves the release not Latest", () => {
  const fake = repo();
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "v0.3.0 is not Latest yet: it still needs the signed OpenBot-mac-arm64.dmg OpenBot-mac-x64.dmg.",
  );
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.latest()).toBe("v0.2.0");
});

test("a candidate pinned to its own release is attached, with no updater signature and no feed", () => {
  const fake = repo();
  const { dir } = job("0.3.0-rc.1", "v0.3.0-rc.1");
  const result = publish(fake, dir, "v0.3.0-rc.1");
  expect(result.code).toBe(0);
  expect(result.out).toContain("pinned to the images of v0.3.0-rc.1");
  expect(uploads(fake, dir)).toEqual([
    "OpenBot_0.3.0-rc.1_x64-setup.exe=signed",
    "OpenBot-windows-x64-setup.exe=signed",
  ]);
  expect(fake.assets()).not.toContain("latest.json");
});

test("a build pinned to another release is not attached", () => {
  const fake = repo();
  const { dir } = job("0.3.0-rc.1", "v0.3.0-rc.2");
  const result = publish(fake, dir, "v0.3.0-rc.1");
  expect(result.code).toBe(1);
  expect(fake.calls()).toEqual([]);
});

// A run from a branch builds an internal version, named after its commit.
test("a build of another version is not attached", () => {
  const fake = repo();
  const { dir } = job("0.3.0-internal.gabcdef123456");
  const result = publish(fake, dir, "v0.3.0");
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "The signed installer is version 0.3.0-internal.gabcdef123456, not 0.3.0.",
  );
  expect(fake.calls()).toEqual([]);
});

test("anything but exactly one installer is not attached", () => {
  const fake = repo();
  const { dir, nsis } = job("0.3.0");
  writeFileSync(join(nsis, "OpenBot_0.3.0_arm64-setup.exe"), "signed");
  const result = publish(fake, dir, "v0.3.0");
  expect(result.code).toBe(1);
  expect(result.out).toContain("Expected one signed -setup.exe");
  expect(fake.calls().some((call) => call.includes("upload"))).toBe(false);
});
