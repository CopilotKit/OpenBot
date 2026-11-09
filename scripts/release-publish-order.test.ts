/**
 * The order publish-release.yml does things in, which is what decides how long a release takes and
 * what it guarantees on the way:
 *
 * - the full CI suite runs on the release commit unless `gate` found it is only the release files on
 *   a commit main's CI passed, and nothing is built or tagged unless one or the other passed;
 * - the signing runs are started as soon as the release they attach to exists, not after a desktop
 *   build of the publish workflow's own;
 * - a stable release builds no installers of its own, since the signing runs' builds are the only
 *   ones it ever carries; a candidate or beta still gets its ad-hoc and unsigned ones, beside the
 *   release rather than before it.
 *
 * Plain reads of the workflow files.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
};
const workflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows", name), "utf8"),
  ) as { jobs: Record<string, Job>; concurrency?: Record<string, unknown> };
const publish = workflow("publish-release.yml");
const job = (name: string) => {
  const found = publish.jobs[name];
  if (!found) throw new Error(`publish-release.yml has no job ${name}`);
  return found;
};
const needs = (name: string) => [job(name).needs ?? []].flat();
/** A workflow expression, as the YAML holds it. */
const expression = (body: string) => `\${{ ${body} }}`;
/** A job's condition, with its whitespace collapsed, for comparing conditions. */
const condition = (name: string) => (job(name).if ?? "").replace(/\s+/g, " ");

test("the gate decides with release-ci-gate.ts, and re-runs the checks that read the release files when it skips the suite", () => {
  const gate = job("gate");
  expect(needs("gate")).toEqual(["metadata", "verify"]);
  expect(gate.outputs?.full_checks).toBe(
    expression("steps.decide.outputs.full_checks"),
  );
  expect(gate.permissions).toEqual({ contents: "read", actions: "read" });
  const steps = gate.steps ?? [];
  const decide = steps.find((step) => step.id === "decide");
  expect(decide?.run).toBe('bun scripts/release-ci-gate.ts "$GITHUB_SHA"');
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  // The release commit and its parent.
  expect(checkout?.with?.["fetch-depth"]).toBe(2);
  const after = steps.slice(steps.indexOf(decide as Step) + 1);
  expect(after.length).toBeGreaterThan(0);
  for (const step of after) {
    expect(step.if).toBe("steps.decide.outputs.full_checks == 'false'");
  }
  const runs = after.map((step) => step.run ?? "").join("\n");
  for (const check of [
    "bun run format:check",
    "bun run lint",
    "bun desktop/scripts/desktop-version.ts check",
    "charts/openbot/Chart.yaml",
    "-e CHANGELOG.md -e release-policy.json",
  ]) {
    expect(runs).toContain(check);
  }
});

test("the full checks run only when the gate says so", () => {
  expect(job("checks").uses).toBe("$/.github/workflows/ci.yml");
  expect(needs("checks")).toEqual(["metadata", "verify", "gate"]);
  expect(condition("checks")).toBe(
    "needs.metadata.outputs.is_release == 'true' && needs.gate.outputs.full_checks == 'true'",
  );
});

// A skipped `checks` must not let anything through unless the gate decided to skip it and then
// passed, re-checks included. A failed gate, or a `checks` skipped for any other reason, stops it.
test("the images are built only after the full checks passed, or after the gate passed having skipped them", () => {
  expect(needs("images")).toEqual(["metadata", "verify", "gate", "checks"]);
  expect(condition("images")).toBe(
    "!cancelled() && needs.metadata.outputs.is_release == 'true' && " +
      "needs.verify.result == 'success' && needs.gate.result == 'success' && " +
      "(needs.checks.result == 'success' || " +
      "(needs.checks.result == 'skipped' && needs.gate.outputs.full_checks == 'false'))",
  );
});

test("the release is created right after the images, and the signing runs are started from it", () => {
  const release = job("github-release");
  // Not after a desktop build: the signing runs need only the release, and for a candidate its
  // container-images.json, which this job attaches.
  // And after the list of the images the Desktop app downloads, which it attaches with
  // container-images.json, so downloads sync always finds both on the release.
  expect(needs("github-release")).toEqual([
    "metadata",
    "verify",
    "images",
    "image-list",
  ]);
  expect(condition("github-release")).toBe(
    "!cancelled() && needs.metadata.outputs.is_release == 'true' && " +
      "needs.verify.result == 'success' && needs.images.result == 'success' && " +
      "needs.image-list.result == 'success'",
  );
  expect(needs("image-list")).toEqual(["metadata", "verify", "images"]);
  const names = (release.steps ?? []).map((step) => step.name);
  const publishAt = names.indexOf("Tag and publish");
  expect(publishAt).toBeGreaterThan(-1);
  expect(names.indexOf("Start signing the Mac build")).toBe(publishAt + 1);
  expect(names.indexOf("Start signing the Windows build")).toBe(publishAt + 2);
  const tag = release.steps?.[publishAt]?.run ?? "";
  expect(tag).toContain(
    'gh release create "$VERSION" container-images.json desktop-images.json release-assets/*',
  );
  // Nothing in this job waits for, or attaches, a desktop build.
  expect(JSON.stringify(release)).not.toContain("openbot-desktop-");
});

test("a stable release builds no installers in the publish run; a candidate or beta builds its own beside the release", () => {
  const desktop = job("desktop");
  expect(desktop.uses).toBe("$/.github/workflows/desktop-build.yml");
  expect(needs("desktop")).toEqual(["metadata", "verify", "images"]);
  expect(condition("desktop")).toBe(
    "!cancelled() && needs.metadata.outputs.prerelease == 'true' && needs.images.result == 'success'",
  );
  // Pinned to the images the candidate was published with.
  expect(desktop.with?.manifest_artifact).toBe(
    expression("needs.images.outputs.manifest-artifact"),
  );
  expect(desktop.with?.bundle_cli).toBe(true);
  expect(desktop.with?.channel).toBe("release");
  // Nothing else in the workflow builds a desktop app.
  for (const [name, other] of Object.entries(publish.jobs)) {
    if (name === "desktop") continue;
    expect(other.uses ?? "").not.toContain("desktop-build.yml");
  }
});

test("a candidate's unsigned installers are attached after the release, by the script that never replaces anything", () => {
  const attach = job("installers");
  expect(needs("installers")).toEqual([
    "metadata",
    "github-release",
    "desktop",
  ]);
  expect(condition("installers")).toBe(
    "!cancelled() && needs.metadata.outputs.prerelease == 'true' && " +
      "needs.github-release.result == 'success' && needs.desktop.result == 'success'",
  );
  const steps = attach.steps ?? [];
  expect(
    steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))
      ?.with?.pattern,
  ).toBe("openbot-desktop-*");
  expect(
    steps.some((step) =>
      step.run?.includes(
        'scripts/release-attach-installers.sh "$VERSION" installers',
      ),
    ),
  ).toBe(true);
  const script = readFileSync(
    join(root, "scripts/release-attach-installers.sh"),
    "utf8",
  );
  expect(script).not.toMatch(/upload[^\n]*--clobber/);
});

test("the merge-back still follows a published final, whether or not the full checks ran", () => {
  expect(needs("merge-back")).toEqual(["metadata", "github-release"]);
  expect(condition("merge-back")).toBe(
    "!cancelled() && needs.metadata.outputs.final_from_candidate == 'true' && needs.github-release.result == 'success'",
  );
});

// v0.3.1's checks waited five minutes for a run of main's CI they shared a group with, and cancelled
// the pending run of the commit the release sat on, so that commit never got the result the gate
// now needs.
test("CI keeps a run for every commit on main, and the release's own checks out of main's group", () => {
  const ci = workflow("ci.yml");
  expect(ci.concurrency).toEqual({
    group:
      `ci-${expression("github.workflow")}-` +
      expression("github.ref == 'refs/heads/main' && github.sha || github.ref"),
    "cancel-in-progress": expression("github.ref != 'refs/heads/main'"),
  });
});
