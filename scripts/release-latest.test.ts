/**
 * Which release `releases/latest` serves, and what a re-run of the publish workflow may replace.
 * The scripts run as the workflows run them, against a pretend `gh`.
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
import { type FakeRepo, fakeRepo, runScript } from "./release-fakes";

const root = join(import.meta.dir, "..");
const becomesLatest = join(root, "scripts/release-becomes-latest.sh");
const attachInstallers = join(root, "scripts/release-attach-installers.sh");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function repo(latest: string): FakeRepo {
  const fake = fakeRepo(latest);
  cleanups.push(fake.cleanup);
  return fake;
}
function temp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function decide(latest: string, version: string, prerelease = "false") {
  const fake = repo(latest);
  return runScript(
    becomesLatest,
    [],
    fake,
    { VERSION: version, PRERELEASE: prerelease },
    root,
  );
}

test("the first stable release becomes Latest", () => {
  const result = decide("", "v0.3.0");
  expect(result).toMatchObject({ code: 0 });
  expect(result.out.trim()).toBe("true");
});

test("a newer stable release becomes Latest, and so does a re-run of the current one", () => {
  expect(decide("v0.2.0", "v0.3.0").out.trim()).toBe("true");
  expect(decide("v0.9.0", "v0.10.0").out.trim()).toBe("true");
  expect(decide("v0.3.0", "v0.3.0").out.trim()).toBe("true");
});

test("a patch to an older line does not take Latest from a newer release", () => {
  expect(decide("v0.4.0", "v0.3.1").out.trim()).toBe("false");
});

test("a candidate or beta never becomes Latest", () => {
  expect(decide("v0.2.0", "v0.3.0-rc.1", "true").out.trim()).toBe("false");
});

test("an API error stops the decision instead of reading as no Latest", () => {
  const result = decide("error", "v0.3.0");
  expect(result.code).toBe(1);
  expect(result.out).toContain("Could not read the current latest release");
});

/** The installers folder the publish job downloads, and what an earlier attempt published. */
function installers(published: string[], version = "0.3.0-rc.1") {
  const dir = temp("installers-");
  mkdirSync(join(dir, "openbot-desktop-macos"));
  mkdirSync(join(dir, "openbot-desktop-windows"));
  writeFileSync(
    join(dir, `openbot-desktop-macos/OpenBot_${version}_aarch64.dmg`),
    "ad-hoc",
  );
  writeFileSync(
    join(dir, `openbot-desktop-windows/OpenBot_${version}_x64-setup.exe`),
    "unsigned",
  );
  writeFileSync(join(dir, "openbot-desktop-macos/build-version.json"), "{}");
  const publishedDir = temp("published-");
  for (const name of published)
    writeFileSync(join(publishedDir, name), "signed");
  return { dir, publishedDir };
}

/**
 * What each `gh release upload` would have attached, as "<asset name>=<content>", in order. The
 * files are still on disk, so the content says which build a fixed-name copy was made from.
 */
function uploads(fake: FakeRepo) {
  return fake
    .calls()
    .filter((call) => call.startsWith("gh release upload "))
    .flatMap((call) =>
      call
        .split(" ")
        .slice(4)
        .filter((arg) => arg !== "--clobber")
        .map((path) => `${basename(path)}=${readFileSync(path, "utf8")}`),
    );
}

function attach(
  fake: FakeRepo,
  dir: string,
  env: Record<string, string> = {},
  tag = "v0.3.0-rc.1",
) {
  return runScript(
    attachInstallers,
    [tag, dir],
    fake,
    { RUNNER_TEMP: temp("runner-"), ...env },
    root,
  );
}

test("a candidate's first publish attaches every installer, and each under its fixed download name", () => {
  const fake = repo("");
  const { dir } = installers([]);
  const list = join(temp("list-"), "attached.txt");
  const result = attach(fake, dir, { ATTACHED_LIST: list });
  expect(result.code).toBe(0);
  expect(fake.calls().slice(0, 1)).toEqual([
    `gh release upload v0.3.0-rc.1 ${dir}/openbot-desktop-macos/OpenBot_0.3.0-rc.1_aarch64.dmg --clobber`,
  ]);
  expect(uploads(fake)).toEqual([
    "OpenBot_0.3.0-rc.1_aarch64.dmg=ad-hoc",
    "OpenBot-mac-arm64.dmg=ad-hoc",
    "OpenBot_0.3.0-rc.1_x64-setup.exe=unsigned",
    "OpenBot-windows-x64-setup.exe=unsigned",
  ]);
  expect(readFileSync(list, "utf8")).toBe(
    "OpenBot_0.3.0-rc.1_aarch64.dmg OpenBot-mac-arm64.dmg\nOpenBot_0.3.0-rc.1_x64-setup.exe OpenBot-windows-x64-setup.exe\n",
  );
});

// The rerun that put an ad-hoc .dmg back over the signed one.
test("a re-run keeps an installer that is already published, such as the signed .dmg", () => {
  const fake = repo("v0.3.0-rc.1");
  const { dir, publishedDir } = installers([
    "OpenBot_0.3.0-rc.1_aarch64.dmg",
    "OpenBot-mac-arm64.dmg",
  ]);
  const result = attach(fake, dir, { OPENBOT_PUBLISHED_ASSETS: publishedDir });
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "OpenBot_0.3.0-rc.1_aarch64.dmg is already published; keeping it.",
  );
  expect(result.out).toContain(
    "OpenBot-mac-arm64.dmg is already a copy of OpenBot_0.3.0-rc.1_aarch64.dmg.",
  );
  expect(uploads(fake)).toEqual([
    "OpenBot_0.3.0-rc.1_x64-setup.exe=unsigned",
    "OpenBot-windows-x64-setup.exe=unsigned",
  ]);
});

// The fixed name must never serve the unsigned build once the signed one is on the release.
test("a fixed-name copy that is missing or stale is made again from the published installer", () => {
  const fake = repo("v0.3.0-rc.1");
  const { dir, publishedDir } = installers([
    "OpenBot_0.3.0-rc.1_aarch64.dmg",
    "OpenBot_0.3.0-rc.1_x64-setup.exe",
  ]);
  // An interrupted signing upload left the old copy under the fixed name.
  writeFileSync(join(publishedDir, "OpenBot-mac-arm64.dmg"), "ad-hoc");
  const result = attach(fake, dir, { OPENBOT_PUBLISHED_ASSETS: publishedDir });
  expect(result.code).toBe(0);
  expect(uploads(fake)).toEqual([
    "OpenBot-mac-arm64.dmg=signed",
    "OpenBot-windows-x64-setup.exe=signed",
  ]);
});

test("an installer with no fixed download name fails before anything is attached", () => {
  const fake = repo("");
  const { dir } = installers([]);
  writeFileSync(
    join(dir, "openbot-desktop-windows/Other_0.3.0-rc.1_x64.exe"),
    "x",
  );
  const result = attach(fake, dir);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "is not an installer with a fixed download name",
  );
  expect(fake.calls()).toEqual([]);
});

test("two installers with one fixed download name fail before anything is attached", () => {
  const fake = repo("");
  const { dir } = installers([]);
  mkdirSync(join(dir, "openbot-desktop-other"));
  writeFileSync(
    join(dir, "openbot-desktop-other/OpenBot_0.3.1_aarch64.dmg"),
    "x",
  );
  const result = attach(fake, dir);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "would both be published as OpenBot-mac-arm64.dmg",
  );
  expect(fake.calls()).toEqual([]);
});

test("a publish with no installers fails", () => {
  const fake = repo("");
  const dir = temp("installers-");
  const result = attach(fake, dir);
  expect(result.code).toBe(1);
  expect(fake.calls()).toEqual([]);
});

// publish-release.yml must leave Latest to the signing run: a stable release is created not
// Latest, a re-run does not touch Latest, and the signing dispatch carries the decision.
// The gap where a stable release became Latest while its Windows link served the unsigned
// installer. On a stable release only the signing runs attach the fixed names, from the signed
// installers, and the release becomes Latest once all of them are there.
test("a stable release's publish attaches the unsigned installers under their own names only", () => {
  const fake = repo("");
  const { dir } = installers([], "0.3.0");
  const list = join(temp("list-"), "attached.txt");
  const result = attach(fake, dir, { ATTACHED_LIST: list }, "v0.3.0");
  expect(result.code).toBe(0);
  expect(uploads(fake)).toEqual([
    "OpenBot_0.3.0_aarch64.dmg=ad-hoc",
    "OpenBot_0.3.0_x64-setup.exe=unsigned",
  ]);
  expect(fake.assets()).not.toContain("OpenBot-windows-x64-setup.exe");
  expect(fake.assets()).not.toContain("OpenBot-mac-arm64.dmg");
  expect(readFileSync(list, "utf8")).toBe(
    "OpenBot_0.3.0_aarch64.dmg OpenBot-mac-arm64.dmg\nOpenBot_0.3.0_x64-setup.exe OpenBot-windows-x64-setup.exe\n",
  );
});

test("publish-release.yml publishes a stable release not Latest and hands the decision to signing", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/publish-release.yml"), "utf8"),
  ) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> };
  const steps = workflow.jobs["github-release"]?.steps ?? [];
  const publish =
    steps.find((step) => step.name === "Tag and publish")?.run ?? "";
  const sign =
    steps.find((step) => step.name === "Start signing the Mac build")?.run ??
    "";
  expect(publish).toContain("create_flags=(--latest=false)");
  expect(publish).not.toMatch(/flags=\(--latest\)/);
  expect(publish).toContain(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own shell text, unexpanded.
    'gh release edit "$VERSION" --title "$VERSION" --notes-file notes.md "${edit_flags[@]}"',
  );
  expect(publish).toContain("scripts/release-attach-installers.sh");
  expect(sign).toContain('-f make-latest="$BECOMES_LATEST"');
  const signWindows =
    steps.find((step) => step.name === "Start signing the Windows build")
      ?.run ?? "";
  expect(signWindows).toContain("gh workflow run desktop-signing.yml");
  expect(signWindows).toContain(
    '-f signing-mode=keyvault -f release-tag="$VERSION"',
  );
  // Both carry the decision: whichever finishes second makes the release Latest.
  expect(signWindows).toContain('-f make-latest="$BECOMES_LATEST"');
});
