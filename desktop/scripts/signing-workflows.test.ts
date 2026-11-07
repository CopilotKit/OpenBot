/**
 * How the signing workflows hand a stable release to Latest. It becomes Latest in whichever signing
 * run, Mac or Windows, attaches the last signed installer, so no download link under
 * `releases/latest/download` ever serves an unsigned one. The scripts behind this run against a
 * pretend `gh` in publish-signed-mac.test.ts, publish-signed-windows.test.ts and
 * scripts/release-latest.test.ts; this checks the workflows call them with the decision.
 *
 * Plain file reads only, so it runs on the Windows signing runner as well as the Mac one.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Workflow = {
  on: { workflow_dispatch?: { inputs?: Record<string, { type?: string }> } };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      environment?: string;
      permissions?: Record<string, string>;
      outputs?: Record<string, string>;
      env?: Record<string, string>;
      steps?: Step[];
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
    }
  >;
};
const workflow = (path: string) => Bun.YAML.parse(read(path)) as Workflow;
/** A workflow expression, as the YAML holds it. */
const expression = (body: string) => `\${{ ${body} }}`;

test("the publish workflow hands the Latest decision to both signing runs", () => {
  const steps = workflow(".github/workflows/publish-release.yml").jobs[
    "github-release"
  ]?.steps;
  for (const name of [
    "Start signing the Mac build",
    "Start signing the Windows build",
  ]) {
    const step = steps?.find((candidate) => candidate.name === name);
    expect(step?.run).toContain('-f make-latest="$BECOMES_LATEST"');
    expect(step?.env?.BECOMES_LATEST).toBe(
      expression("needs.verify.outputs.becomes_latest"),
    );
  }
});

test("Windows signing takes the decision and can make the release Latest", () => {
  const windows = workflow(".github/workflows/desktop-signing.yml");
  expect(windows.on.workflow_dispatch?.inputs?.["make-latest"]?.type).toBe(
    "boolean",
  );
  expect(windows.jobs.publish?.env?.MAKE_LATEST).toBe(
    expression("inputs.make-latest"),
  );
  expect(read("desktop/scripts/publish-signed-windows.sh")).toContain(
    '"$root/scripts/release-make-latest.sh"',
  );
});

test("Mac signing makes the release Latest through the same script", () => {
  const mac = workflow(".github/workflows/desktop-macos-signing.yml");
  expect(mac.jobs.publish?.env?.MAKE_LATEST).toBe(
    expression("inputs.make-latest"),
  );
  const script = read("desktop/scripts/publish-signed-mac.sh");
  expect(script).toContain('"$root/scripts/release-make-latest.sh"');
  expect(script).not.toContain("--latest");
});

// What release-make-latest.sh waits for: latest.json and every fixed name. On a stable release
// only the signing runs attach those, so their presence means each installer is signed.
test("a stable release waits for every signed installer, and the publish workflow attaches no fixed name for one", () => {
  const promote = read("scripts/release-make-latest.sh");
  expect(promote).toContain('release-download-names.sh" --all');
  expect(promote).toContain("latest.json");
  expect(read("scripts/release-attach-installers.sh")).toContain(
    'if [[ "$version" != *-* ]]; then',
  );
});

// The two attach jobs of one release run one after the other, so the second always sees what the
// first attached and makes the release Latest. Without the shared group they can both look before
// either has uploaded, and the release would stay not Latest.
test("the Mac and Windows attach jobs of one release never run at the same time", () => {
  for (const path of [
    ".github/workflows/desktop-macos-signing.yml",
    ".github/workflows/desktop-signing.yml",
  ]) {
    const publish = workflow(path).jobs.publish;
    expect(publish?.concurrency?.group).toBe(
      `release-attach-${expression("inputs.release-tag || github.ref_name")}`,
    );
    expect(publish?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(
      publish?.steps?.some((step) =>
        /publish-signed-(mac|windows)\.sh/.test(step.run ?? ""),
      ),
    ).toBe(true);
  }
});

// On Windows the updater installs the signed installer itself, and the updater key lives only in
// `macos-signing`. A job there signs the installer the signing job verified, and the attach job
// waits for it and lists the installer in latest.json.
test("Windows signing signs its installer for the updater with the Mac's key, then attaches and lists it", () => {
  const windows = workflow(".github/workflows/desktop-signing.yml");
  const sign = windows.jobs.sign;
  expect(sign?.outputs?.updater).toBe(
    expression("steps.build.outputs.updater"),
  );
  const build = sign?.steps?.find((step) => step.name === "Build and sign");
  expect(build?.id).toBe("build");
  expect(build?.run).toContain("src-tauri/tauri.windows-signing.conf.json");

  const update = windows.jobs["sign-update"];
  expect(update?.needs).toBe("sign");
  expect(update?.environment).toBe("macos-signing");
  expect(update?.permissions).toEqual({ contents: "read" });
  // Only a run that attaches to a release, and only a build with the updater.
  expect(update?.if).toContain("inputs.release-tag != ''");
  expect(update?.if).toContain("needs.sign.outputs.updater == 'true'");
  const steps = update?.steps ?? [];
  const download = steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  // The bytes the signing job verified, Authenticode signature and all.
  expect(download?.with?.name).toBe(expression("needs.sign.outputs.artifact"));
  const signing = steps.find((step) =>
    step.run?.includes("desktop/scripts/sign-windows-update.sh"),
  );
  expect(signing?.env?.TAURI_SIGNING_PRIVATE_KEY).toBe(
    expression("secrets.TAURI_SIGNING_PRIVATE_KEY"),
  );
  expect(signing?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe(
    expression("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
  );
  expect(steps.some((step) => step.run?.includes("minisign"))).toBe(true);
  // The key is in no other job of this workflow.
  for (const [name, job] of Object.entries(windows.jobs)) {
    if (name === "sign-update") continue;
    expect(JSON.stringify(job)).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  }

  const publish = windows.jobs.publish;
  expect(publish?.needs).toEqual(["sign", "sign-update"]);
  // A pinned build skips sign-update and is still attached.
  expect(publish?.if).toContain("needs.sign-update.result == 'skipped'");
  expect(
    publish?.steps?.find(
      (step) =>
        step.with?.name === expression("needs.sign-update.outputs.artifact"),
    )?.if,
  ).toBe("needs.sign-update.result == 'success'");
  expect(read("desktop/scripts/publish-signed-windows.sh")).toContain(
    '"$root/scripts/release-update-feed.sh" "windows-x86_64=$installer"',
  );
  expect(read("desktop/scripts/publish-signed-mac.sh")).toContain(
    '"$root/scripts/release-update-feed.sh"',
  );
});

// Latest waits for a feed that lists every platform, so no release is ever Latest with Windows apps
// left out of it.
test("a stable release becomes Latest only once its feed lists Mac and Windows", () => {
  expect(read("scripts/release-update-feed.sh")).toContain(
    "printf '%s\\n' darwin-aarch64 darwin-x86_64 windows-x86_64",
  );
  expect(read("scripts/release-make-latest.sh")).toContain(
    'release-update-feed.sh" --platforms',
  );
});
