import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCommand,
  buildEnv,
  CLI_OVERLAY,
  PINNED_OVERLAY,
  planSignedBuild,
  type Runner,
} from "./signed-build";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const real = (path: string) =>
  readFileSync(join(import.meta.dir, "..", path), "utf8");

/** A desktop/ folder with the real signing overlays and a build record. */
function desktop(record: Record<string, unknown>, cliOverlay = false) {
  const dir = mkdtempSync(join(tmpdir(), "signed-build-"));
  temps.push(dir);
  mkdirSync(join(dir, "src-tauri"));
  for (const overlay of [
    "src-tauri/tauri.macos-signing.conf.json",
    "src-tauri/tauri.windows-signing.conf.json",
  ]) {
    writeFileSync(join(dir, overlay), real(overlay));
  }
  if (cliOverlay) writeFileSync(join(dir, CLI_OVERLAY), "{}\n");
  writeFileSync(
    join(dir, "build-version.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return dir;
}

const stable = {
  version: "0.3.0",
  releaseVersion: "0.3.0",
  sourceSha: SHA,
  channel: "release",
};
const candidate = {
  version: "0.3.0-rc.1",
  releaseVersion: "0.3.0-rc.1",
  sourceSha: SHA,
  channel: "release",
};

/** A runner standing in for gh and cli-bundle.ts. `manifest` is the release's asset. */
function fakeRun(manifest?: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: Runner = (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "gh") {
      if (!manifest)
        return { code: 1, stdout: "", stderr: "release not found" };
      const dir = cmd[cmd.indexOf("--dir") + 1] as string;
      writeFileSync(
        join(dir, "container-images.json"),
        JSON.stringify(manifest),
      );
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function plan(
  dir: string,
  run: Runner,
  platform: "darwin" | "win32" = "darwin",
) {
  return planSignedBuild({
    desktop: dir,
    platform,
    arch: platform === "darwin" ? "arm64" : "x64",
    overlay:
      platform === "darwin"
        ? "src-tauri/tauri.macos-signing.conf.json"
        : "src-tauri/tauri.windows-signing.conf.json",
    repository: "CopilotKit/OpenBot",
    workDir: join(dir, "work"),
    bun: "bun",
    run,
  });
}

test("a stable release is signed unpinned, with the updater, from the signing overlay as it is", () => {
  const dir = desktop(stable);
  const { run, calls } = fakeRun();
  const result = plan(dir, run);
  expect(result.pinned).toBeNull();
  expect(result.updater).toBe(true);
  expect(result.configs).toEqual([
    "src-tauri/tauri.macos-signing.conf.json",
    "src-tauri/tauri.build-version.conf.json",
  ]);
  expect(result.env).toEqual({});
  expect(result.unset).toEqual([]);
  expect(calls).toEqual([]);
});

test("a candidate is pinned to its own release's images, and carries no updater", () => {
  const dir = desktop(candidate);
  const { run, calls } = fakeRun({
    version: "v0.3.0-rc.1",
    commit: SHA,
    images: {},
  });
  const result = plan(dir, run);

  expect(calls[0]).toEqual([
    "gh",
    "release",
    "download",
    "v0.3.0-rc.1",
    "--repo",
    "CopilotKit/OpenBot",
    "--pattern",
    "container-images.json",
    "--dir",
    join(dir, "work"),
    "--clobber",
  ]);
  expect(result.pinned).toBe("v0.3.0-rc.1");
  expect(result.env.OPENBOT_PINNED_DEPLOYMENT).toBe(
    join(dir, "work", "container-images.json"),
  );
  expect(result.updater).toBe(false);
  expect(result.configs).toEqual([
    PINNED_OVERLAY,
    "src-tauri/tauri.build-version.conf.json",
  ]);

  // The signing overlay without its updater: still the app and the dmg, no feed, no archives.
  const overlay = JSON.parse(readFileSync(join(dir, PINNED_OVERLAY), "utf8"));
  expect(overlay.plugins).toBeUndefined();
  expect(overlay.bundle.createUpdaterArtifacts).toBeUndefined();
  expect(overlay.bundle.targets).toEqual(["app", "dmg"]);

  // The updater key never reaches a build that makes no updater archive.
  expect(result.unset).toEqual([
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]);
  const env = buildEnv(
    {
      PATH: "/bin",
      TAURI_SIGNING_PRIVATE_KEY: "secret",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "pw",
    },
    result,
  );
  expect(env.TAURI_SIGNING_PRIVATE_KEY).toBeUndefined();
  expect(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBeUndefined();
  expect(env.PATH).toBe("/bin");

  // The record the publish job reads says what the build was pinned to.
  const record = JSON.parse(
    readFileSync(join(dir, "build-version.json"), "utf8"),
  );
  expect(record.pinned).toBe("v0.3.0-rc.1");
});

test("a beta is pinned the same way", () => {
  const dir = desktop({
    ...candidate,
    version: "0.3.0-beta.2",
    releaseVersion: "0.3.0-beta.2",
  });
  const { run } = fakeRun({
    version: "v0.3.0-beta.2",
    commit: SHA,
    images: {},
  });
  expect(plan(dir, run).pinned).toBe("v0.3.0-beta.2");
});

test("a candidate refuses a manifest from another commit", () => {
  const dir = desktop(candidate);
  const { run } = fakeRun({
    version: "v0.3.0-rc.1",
    commit: OTHER_SHA,
    images: {},
  });
  expect(() => plan(dir, run)).toThrow(
    /was built from b{40}, but this build is a{40}/,
  );
  expect(existsSync(join(dir, PINNED_OVERLAY))).toBe(false);
});

test("a candidate refuses a manifest for another release", () => {
  const dir = desktop(candidate);
  const { run } = fakeRun({ version: "v0.3.0-rc.2", commit: SHA, images: {} });
  expect(() => plan(dir, run)).toThrow(/names v0.3.0-rc.2, not v0.3.0-rc.1/);
});

test("a candidate with no release to pin to is not built", () => {
  const dir = desktop(candidate);
  const { run } = fakeRun();
  expect(() => plan(dir, run)).toThrow(
    /gh release download v0.3.0-rc.1 .* failed: release not found/,
  );
});

test("an internal signed build is never pinned, even from a candidate's branch", () => {
  const dir = desktop({
    version: "0.3.0-rc.1-internal.gaaaaaaaaaaaa",
    releaseVersion: "0.3.0-rc.1",
    sourceSha: SHA,
    channel: "internal",
  });
  const { run, calls } = fakeRun();
  const result = plan(dir, run);
  expect(result.pinned).toBeNull();
  expect(calls).toEqual([]);
});

test("a Windows candidate is pinned, and its overlay keeps the signing command", () => {
  const dir = desktop(candidate);
  const { run } = fakeRun({ version: "v0.3.0-rc.1", commit: SHA, images: {} });
  const result = plan(dir, run, "win32");
  expect(result.pinned).toBe("v0.3.0-rc.1");
  expect(result.updater).toBe(false);
  const overlay = JSON.parse(readFileSync(join(dir, PINNED_OVERLAY), "utf8"));
  expect(overlay.bundle.windows.signCommand.args).toContain(
    "../scripts/sign-windows.ps1",
  );
});

test("the CLI is bundled whenever the tree has the overlay for it, pinned or not", () => {
  for (const record of [stable, candidate]) {
    const dir = desktop(record, true);
    const { run, calls } = fakeRun({
      version: "v0.3.0-rc.1",
      commit: SHA,
      images: {},
    });
    const result = planSignedBuild({
      desktop: dir,
      platform: "darwin",
      arch: "x64",
      overlay: "src-tauri/tauri.macos-signing.conf.json",
      repository: "CopilotKit/OpenBot",
      workDir: join(dir, "work"),
      bun: "bun",
      run,
    });
    expect(calls.at(-1)).toEqual([
      "bun",
      join(dir, "scripts", "cli-bundle.ts"),
      "darwin",
      "x64",
    ]);
    expect(result.configs.at(-1)).toBe(CLI_OVERLAY);
    expect(result.env.OPENBOT_BUNDLED_CLI).toBe("1");
  }
});

test("the build command passes every overlay in order, then the caller's arguments", () => {
  const dir = desktop(candidate, true);
  const { run } = fakeRun({ version: "v0.3.0-rc.1", commit: SHA, images: {} });
  const result = plan(dir, run, "win32");
  expect(buildCommand("bun", result, ["--bundles", "nsis"])).toEqual([
    "bun",
    "run",
    "tauri",
    "build",
    "--config",
    PINNED_OVERLAY,
    "--config",
    "src-tauri/tauri.build-version.conf.json",
    "--config",
    CLI_OVERLAY,
    "--bundles",
    "nsis",
  ]);
});

// The signing workflow is what ships, so it must build through this script rather than call
// `tauri build` itself, which builds every candidate unpinned.
test("Desktop macOS signing builds through signed-build.ts", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      join(
        import.meta.dir,
        "../../.github/workflows/desktop-macos-signing.yml",
      ),
      "utf8",
    ),
  ) as { jobs: { sign: { steps: { name?: string; run?: string }[] } } };
  const build = workflow.jobs.sign.steps.find(
    (step) => step.name === "Build, sign and notarize",
  );
  expect(build?.run?.trim()).toBe(
    'bun desktop/scripts/signed-build.ts darwin "$ARCH" src-tauri/tauri.macos-signing.conf.json',
  );
  const others = workflow.jobs.sign.steps.filter((step) => step !== build);
  expect(others.some((step) => /tauri build/.test(step.run ?? ""))).toBe(false);
});

// A release's installers are attached to it, so they are built from the tree and the lockfiles
// alone. A release branch can restore caches written on main.
test("desktop-build.yml restores no cache for a release", () => {
  const text = readFileSync(
    join(import.meta.dir, "../../.github/workflows/desktop-build.yml"),
    "utf8",
  );
  const workflow = Bun.YAML.parse(text) as {
    jobs: {
      app: {
        steps: { uses?: string; if?: string; with?: Record<string, unknown> }[];
      };
    };
  };
  const steps = workflow.jobs.app.steps;
  const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, unexpanded.
  expect(bun?.with?.["no-cache"]).toBe("${{ inputs.channel == 'release' }}");
  const rust = steps.find((step) =>
    step.uses?.startsWith("Swatinem/rust-cache@"),
  );
  expect(rust?.if).toBe("inputs.channel != 'release'");
});
