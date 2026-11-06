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
  fakeRepo,
  runScript,
} from "../../scripts/release-fakes";

const root = join(import.meta.dir, "../..");
const script = join(root, "desktop/scripts/publish-signed-windows.sh");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A job folder holding the signing artifact of `version`, laid out as upload-artifact keeps it. */
function job(version: string, pinned?: string) {
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

test("a stable release gets the signed installer under its own name and its fixed name, in one upload", () => {
  const fake = repo();
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0");
  expect(result.code).toBe(0);
  expect(fake.calls()[0]).toBe("gh release view v0.3.0 -R CopilotKit/OpenBot");
  expect(
    fake.calls().filter((call) => call.startsWith("gh release upload")),
  ).toHaveLength(1);
  expect(fake.calls()[1]).toEndWith(" --clobber");
  expect(uploads(fake, dir)).toEqual([
    "OpenBot_0.3.0_x64-setup.exe=signed",
    "OpenBot-windows-x64-setup.exe=signed",
  ]);
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
  fake.attach(
    "latest.json",
    "OpenBot_0.3.0_aarch64.dmg",
    "OpenBot_0.3.0_x64.dmg",
    "OpenBot-mac-arm64.dmg",
    "OpenBot-mac-x64.dmg",
  );
  fake.feed("v0.3.0", {
    version: "0.3.0",
    platforms: {
      "darwin-aarch64": { url: "https://example.test/a", signature: "s" },
    },
  });
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  const calls = fake.calls();
  const upload = calls.findIndex((call) =>
    call.startsWith("gh release upload"),
  );
  const promote = calls.indexOf(
    "gh release edit v0.3.0 -R CopilotKit/OpenBot --latest",
  );
  expect(promote).toBeGreaterThan(upload);
  expect(fake.latest()).toBe("v0.3.0");
  expect(result.out).toContain("serves latest.json for 0.3.0.");
});

test("Windows signing that finishes before Mac signing leaves the release not Latest", () => {
  const fake = repo();
  const { dir } = job("0.3.0");
  const result = publish(fake, dir, "v0.3.0", "true");
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "v0.3.0 is not Latest yet: it still needs the signed latest.json OpenBot-mac-arm64.dmg OpenBot-mac-x64.dmg.",
  );
  expect(fake.calls().some((call) => call.startsWith("gh release edit"))).toBe(
    false,
  );
  expect(fake.latest()).toBe("v0.2.0");
});

test("a candidate pinned to its own release is attached", () => {
  const fake = repo();
  const { dir } = job("0.3.0-rc.1", "v0.3.0-rc.1");
  const result = publish(fake, dir, "v0.3.0-rc.1");
  expect(result.code).toBe(0);
  expect(result.out).toContain("pinned to the images of v0.3.0-rc.1");
  expect(uploads(fake, dir)).toEqual([
    "OpenBot_0.3.0-rc.1_x64-setup.exe=signed",
    "OpenBot-windows-x64-setup.exe=signed",
  ]);
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
