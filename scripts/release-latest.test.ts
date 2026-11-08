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

/** The installers folder the publish job downloads. */
function installers(version = "0.3.0-rc.1") {
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
  return { dir };
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

/** Whether any upload asked to replace what the release has. */
function clobbered(fake: FakeRepo) {
  return fake
    .calls()
    .some(
      (call) =>
        call.startsWith("gh release upload ") && call.includes("--clobber"),
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
  const { dir } = installers();
  const list = join(temp("list-"), "attached.txt");
  const result = attach(fake, dir, { ATTACHED_LIST: list });
  expect(result.code).toBe(0);
  expect(fake.calls()[0]).toStartWith(
    "gh release view v0.3.0-rc.1 --json assets",
  );
  expect(uploads(fake)).toEqual([
    "OpenBot_0.3.0-rc.1_aarch64.dmg=ad-hoc",
    "OpenBot-mac-arm64.dmg=ad-hoc",
    "OpenBot_0.3.0-rc.1_x64-setup.exe=unsigned",
    "OpenBot-windows-x64-setup.exe=unsigned",
  ]);
  expect(clobbered(fake)).toBe(false);
  expect(readFileSync(list, "utf8")).toBe(
    "OpenBot_0.3.0-rc.1_aarch64.dmg OpenBot-mac-arm64.dmg\nOpenBot_0.3.0-rc.1_x64-setup.exe OpenBot-windows-x64-setup.exe\n",
  );
});

// The rerun that put an ad-hoc .dmg back over the signed one.
test("a re-run keeps an installer that is already on the release, such as the signed .dmg", () => {
  const fake = repo("v0.3.0-rc.1");
  fake.attachFile("OpenBot_0.3.0-rc.1_aarch64.dmg", "signed");
  fake.attachFile("OpenBot-mac-arm64.dmg", "signed");
  const { dir } = installers();
  const result = attach(fake, dir);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "OpenBot_0.3.0-rc.1_aarch64.dmg is already on the release; keeping it.",
  );
  expect(result.out).toContain(
    "OpenBot-mac-arm64.dmg is already on the release; keeping it.",
  );
  expect(uploads(fake)).toEqual([
    "OpenBot_0.3.0-rc.1_x64-setup.exe=unsigned",
    "OpenBot-windows-x64-setup.exe=unsigned",
  ]);
  expect(fake.file("OpenBot_0.3.0-rc.1_aarch64.dmg")).toBe("signed");
  expect(fake.file("OpenBot-mac-arm64.dmg")).toBe("signed");
  expect(clobbered(fake)).toBe(false);
});

// The fixed name must never serve the unsigned build once the signed one is on the release.
test("a missing fixed-name copy is made from the installer on the release, which may be the signed one", () => {
  const fake = repo("v0.3.0-rc.1");
  fake.attachFile("OpenBot_0.3.0-rc.1_aarch64.dmg", "signed");
  fake.attachFile("OpenBot_0.3.0-rc.1_x64-setup.exe", "signed");
  const { dir } = installers();
  const result = attach(fake, dir);
  expect(result.code).toBe(0);
  expect(uploads(fake)).toEqual([
    "OpenBot-mac-arm64.dmg=signed",
    "OpenBot-windows-x64-setup.exe=signed",
  ]);
  expect(clobbered(fake)).toBe(false);
});

// Signing now starts before the candidate's unsigned installers are built, so a signing run can
// attach its signed build between this script reading the release and its upload landing. The
// signed one stays, and the fixed-name copy is made from it.
test("an installer a signing run attaches meanwhile is kept, and its fixed name is copied from it", () => {
  const fake = repo("v0.3.0-rc.1");
  fake.race("OpenBot_0.3.0-rc.1_aarch64.dmg", "signed");
  const { dir } = installers();
  const result = attach(fake, dir);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    "OpenBot_0.3.0-rc.1_aarch64.dmg was attached by another run meanwhile; keeping that one.",
  );
  expect(fake.file("OpenBot_0.3.0-rc.1_aarch64.dmg")).toBe("signed");
  expect(fake.file("OpenBot-mac-arm64.dmg")).toBe("signed");
  expect(fake.file("OpenBot_0.3.0-rc.1_x64-setup.exe")).toBe("unsigned");
  expect(clobbered(fake)).toBe(false);
});

test("a fixed name a signing run attaches meanwhile is kept", () => {
  const fake = repo("v0.3.0-rc.1");
  fake.race("OpenBot-windows-x64-setup.exe", "signed");
  const { dir } = installers();
  const result = attach(fake, dir);
  expect(result.code).toBe(0);
  expect(fake.file("OpenBot-windows-x64-setup.exe")).toBe("signed");
  expect(clobbered(fake)).toBe(false);
});

test("an upload that fails for any other reason fails the run", () => {
  const fake = repo("v0.3.0-rc.1");
  fake.failUpload("OpenBot_0.3.0-rc.1_x64-setup.exe");
  const { dir } = installers();
  const result = attach(fake, dir);
  expect(result.code).toBe(1);
  expect(result.out).toContain(
    "Could not attach OpenBot_0.3.0-rc.1_x64-setup.exe to v0.3.0-rc.1.",
  );
});

// A signing run attaches with --clobber, so it replaces whatever this script added, in either order.
test("a signing run's attach replaces both names this script added", () => {
  const fake = repo("v0.3.0-rc.1");
  const { dir } = installers();
  expect(attach(fake, dir).code).toBe(0);
  expect(fake.file("OpenBot-mac-arm64.dmg")).toBe("ad-hoc");
  const signedDir = temp("signed-");
  writeFileSync(join(signedDir, "OpenBot_0.3.0-rc.1_aarch64.dmg"), "signed");
  writeFileSync(join(signedDir, "OpenBot-mac-arm64.dmg"), "signed");
  const upload = Bun.spawnSync(
    [
      join(fake.dir, "bin", "gh"),
      "release",
      "upload",
      "v0.3.0-rc.1",
      join(signedDir, "OpenBot_0.3.0-rc.1_aarch64.dmg"),
      join(signedDir, "OpenBot-mac-arm64.dmg"),
      "--clobber",
    ],
    { env: { ...process.env, ...fake.env } },
  );
  expect(upload.exitCode).toBe(0);
  expect(fake.file("OpenBot_0.3.0-rc.1_aarch64.dmg")).toBe("signed");
  expect(fake.file("OpenBot-mac-arm64.dmg")).toBe("signed");
});

test("an installer with no fixed download name fails before anything is attached", () => {
  const fake = repo("");
  const { dir } = installers();
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
  const { dir } = installers();
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

// The gap where a stable release became Latest while its Windows link served the unsigned
// installer. On a stable release only the signing runs attach the fixed names, from the signed
// installers, and the release becomes Latest once all of them are there. publish-release.yml no
// longer calls this script for a stable release at all; called for one, it still attaches no fixed
// name.
test("for a stable version the script attaches the installers under their own names only", () => {
  const fake = repo("");
  const { dir } = installers("0.3.0");
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

// publish-release.yml must leave Latest to the signing run: a stable release is created not
// Latest, a re-run does not touch Latest, and the signing dispatch carries the decision.
test("publish-release.yml publishes a stable release not Latest and hands the decision to signing", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/publish-release.yml"), "utf8"),
  ) as {
    jobs: Record<
      string,
      { if?: string; steps?: { name?: string; run?: string }[] }
    >;
  };
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
  // The release attaches no installer itself: a stable release carries only the signing runs'
  // builds, and a candidate's unsigned ones come from the `installers` job, for a candidate only.
  expect(publish).not.toContain("release-attach-installers.sh");
  const attachJob = workflow.jobs.installers;
  expect(attachJob?.if).toContain(
    "needs.metadata.outputs.prerelease == 'true'",
  );
  expect(
    attachJob?.steps?.some((step) =>
      step.run?.includes("scripts/release-attach-installers.sh"),
    ),
  ).toBe(true);
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
