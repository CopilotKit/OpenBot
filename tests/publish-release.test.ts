import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type Job = {
  "runs-on": string;
  needs?: string[];
  strategy?: {
    matrix?: { platform?: Array<{ arch: string; runner: string }> };
  };
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};

const workflow = parse(
  readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "publish-release.yml"),
    "utf8",
  ),
) as { jobs: Record<string, Job> };

const OPENBOT = "ghcr.io/copilotkit/openbot";

// The machines are laptops as well as servers: arm64 Macs and amd64 everything else. Native runners
// for each, never QEMU, for the reason the workflow gives on `component-images`.
const NATIVE_PLATFORMS = [
  { arch: "amd64", runner: "ubuntu-latest" },
  { arch: "arm64", runner: "ubuntu-24.04-arm" },
];

const isBuild = (step: Step) =>
  step.uses?.startsWith("docker/build-push-action@") ?? false;

/** The jobs that push an image, with the repository each one pushes to. */
function buildJobs(): Array<{ name: string; job: Job; build: Step }> {
  return Object.entries(workflow.jobs).flatMap(([name, job]) =>
    (job.steps ?? []).filter(isBuild).map((build) => ({ name, job, build })),
  );
}

function pushesOpenbot(build: Step): boolean {
  const target = `${build.with?.outputs ?? ""}\n${build.with?.tags ?? ""}`;
  return new RegExp(`${OPENBOT}(?![-\\w])`).test(target);
}

/** The job that writes tags over both architectures of one repository. */
function manifestJobFor(repository: string): [string, Job] | undefined {
  return Object.entries(workflow.jobs).find(([, job]) =>
    (job.steps ?? []).some(
      (step) =>
        step.run?.includes("docker buildx imagetools create") &&
        step.env?.REPOSITORY === repository,
    ),
  );
}

describe("publish-release.yml", () => {
  test("the single openbot image is one of the images the release builds", () => {
    expect(buildJobs().some(({ build }) => pushesOpenbot(build))).toBe(true);
  });

  test("every image the release pushes is built on a native runner of each architecture", () => {
    for (const { name, job, build } of buildJobs()) {
      expect({ name, platforms: job.strategy?.matrix?.platform }).toEqual({
        name,
        platforms: NATIVE_PLATFORMS,
      });
      expect({ name, runsOn: job["runs-on"] }).toEqual({
        name,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is asserted.
        runsOn: "${{ matrix.platform.runner }}",
      });
      expect({ name, platforms: build.with?.platforms }).toEqual({
        name,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is asserted.
        platforms: "linux/${{ matrix.platform.arch }}",
      });
    }
  });

  // A tag written by one architecture's leg would name that architecture, and the two legs would
  // race to own it.
  test("a build leg pushes by digest and writes no tags", () => {
    for (const { name, build } of buildJobs()) {
      expect({ name, tags: build.with?.tags }).toEqual({
        name,
        tags: undefined,
      });
      expect({ name, outputs: build.with?.outputs }).toEqual({
        name,
        outputs: expect.stringContaining("push-by-digest=true"),
      });
    }
  });

  test("the openbot tags are written once, over both architectures, and the release pins that list", () => {
    const manifest = manifestJobFor(OPENBOT);
    expect(manifest).toBeDefined();
    const [manifestName, manifestJob] = manifest as [string, Job];

    const merge = (manifestJob.steps ?? []).find((step) =>
      step.run?.includes("imagetools create"),
    ) as Step;
    // Quoting and `$X` against `${X}` are style, so either spelling is accepted.
    for (const tag of ["\\$\\{?VERSION\\}?", "\\$\\{?COMMIT\\}?", "latest"]) {
      expect(merge.run).toMatch(
        new RegExp(`--tag\\s+"?\\$\\{?REPOSITORY\\}?:${tag}"?`),
      );
    }
    expect(merge.run).toMatch(/for arch in amd64 arm64\b/);

    // The attestation and the release both name the list, so `gh attestation verify` on a tag and
    // a deploy by digest refer to the same thing.
    const attest = (manifestJob.steps ?? []).find((step) =>
      step.uses?.startsWith("actions/attest-build-provenance@"),
    ) as Step;
    expect(attest.with?.["subject-name"]).toBe(OPENBOT);
    expect(attest.with?.["subject-digest"]).toBe(
      `\${{ steps.${merge.id}.outputs.digest }}`,
    );
    expect(manifestJob.outputs?.digest).toBe(
      `\${{ steps.${merge.id}.outputs.digest }}`,
    );

    const release = workflow.jobs["github-release"] as Job;
    expect(release.needs).toContain(manifestName);
    const write = (release.steps ?? []).find(
      (step) => step.name === "Write the image manifest",
    ) as Step;
    expect(write.env?.DIGEST).toBe(
      `\${{ needs.${manifestName}.outputs.digest }}`,
    );
  });

  // The digests travel as artifacts, so a name that differs by one character between upload and
  // download, or a manifest job that does not wait for the builds, fails only on release day.
  test("the openbot manifest job waits for the builds and downloads exactly what they upload", () => {
    const [manifestName, manifestJob] = manifestJobFor(OPENBOT) as [
      string,
      Job,
    ];
    const builds = buildJobs().filter(({ build }) => pushesOpenbot(build));
    expect(builds.length).toBe(1);
    const { name: buildName, job: buildJob } = builds[0] as (typeof builds)[0];
    expect(manifestJob.needs).toContain(buildName);

    const uploaded = (buildJob.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .flatMap((step) =>
        NATIVE_PLATFORMS.map(({ arch }) =>
          String(step.with?.name).replace(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded Actions expression is what is replaced.
            "${{ matrix.platform.arch }}",
            arch,
          ),
        ),
      );
    const downloaded = (manifestJob.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => String(step.with?.name));
    expect(downloaded.sort()).toEqual(uploaded.sort());
    expect(downloaded.length).toBe(NATIVE_PLATFORMS.length);

    // Pushing the list and signing its attestation need all three.
    expect({ job: manifestName, permissions: manifestJob.permissions }).toEqual(
      {
        job: manifestName,
        permissions: expect.objectContaining({
          packages: "write",
          "id-token": "write",
          attestations: "write",
        }),
      },
    );
  });

  // `github-release` counts `manifest-*` artifacts against the component list and refuses to
  // write the release if the numbers differ, so the openbot image must not add one.
  test("the openbot image's artifacts stay out of the component manifest count", () => {
    const openbotJobs = new Set([
      ...buildJobs()
        .filter(({ build }) => pushesOpenbot(build))
        .map(({ name }) => name),
      ...(manifestJobFor(OPENBOT)?.slice(0, 1) ?? []),
    ] as string[]);
    for (const name of openbotJobs) {
      const uploads = ((workflow.jobs[name] as Job).steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
        .map((step) => String(step.with?.name));
      for (const upload of uploads) {
        expect({ name, upload }).not.toEqual({
          name,
          upload: expect.stringMatching(/^manifest-/),
        });
      }
    }
  });
});
