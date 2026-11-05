import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shellDistribution,
  shellUpdateManifest,
} from "../desktop/scripts/shell-update-manifest";
import { readReleaseConfiguration } from "../scripts/release-manifest";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
test("signed shell publication refuses insecure artifacts and retains distributor identity", async () => {
  const distribution = {
    id: "acme.openbot",
    repository: "acme/openbot",
    channel: "stable",
  };
  const artifact = {
    target: "darwin-aarch64",
    url: "https://updates.example/OpenBot.app.tar.gz",
    signature: "synthetic signature",
  };
  expect(
    shellUpdateManifest("0.3.0", [artifact], distribution).distribution,
  ).toEqual(distribution);
  expect(() =>
    shellUpdateManifest(
      "0.3.0",
      [{ ...artifact, url: "http://updates.example/unsigned" }],
      distribution,
    ),
  ).toThrow();
  expect(() =>
    shellUpdateManifest(
      "0.3.0",
      [{ ...artifact, signature: "" }],
      distribution,
    ),
  ).toThrow();
});

test("shell publication CLI writes reviewable metadata and refuses to replace it", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-shell-manifest-"));
  temporary.push(root);
  const signature = join(root, "artifact.sig"),
    output = join(root, "latest.json");
  writeFileSync(signature, "synthetic signature");
  const command = [
    process.execPath,
    join(import.meta.dir, "../desktop/scripts/shell-update-manifest.ts"),
    "--version",
    "0.3.0",
    "--target",
    "darwin-aarch64",
    "--url",
    "https://updates.example/OpenBot.app.tar.gz",
    "--signature",
    signature,
    "--output",
    output,
  ];
  const env = {
    ...process.env,
    OPENBOT_DISTRIBUTION_ID: "acme.openbot",
    OPENBOT_RELEASE_REPOSITORY: "acme/openbot",
    OPENBOT_RELEASE_CHANNEL: "stable",
  };
  const first = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode).toBe(0);
  const accepted = readFileSync(output, "utf8");
  expect(JSON.parse(accepted).distribution.repository).toBe("acme/openbot");
  const repeated = Bun.spawnSync(command, {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(repeated.exitCode).not.toBe(0);
  expect(readFileSync(output, "utf8")).toBe(accepted);
});
test("shell build entrypoint refuses absent trust before native work without exposing signing material", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../desktop/scripts/build-shell-update.ts"),
    ],
    {
      env: {
        ...process.env,
        OPENBOT_SHELL_UPDATE_PUBLIC_KEY: "",
        OPENBOT_SHELL_UPDATE_ENDPOINT: "",
        TAURI_SIGNING_PRIVATE_KEY: "synthetic-private-test-material",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "Missing required shell release configuration",
  );
  expect(result.stderr.toString()).not.toContain(
    "synthetic-private-test-material",
  );
});

test("shell build supplies the compiled public trust to Tauri's artifact bundler", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-shell-build-"));
  temporary.push(root);
  const preload = join(root, "capture-native-build.js");
  const capture = join(root, "native-build.json");
  // Exercise the entrypoint while replacing only the expensive external native build boundary.
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
Bun.spawnSync = (argv, options) => {
  writeFileSync(process.env.OPENBOT_BUILD_CAPTURE, JSON.stringify({
    argv,
    privateKeyAvailable: options.env.TAURI_SIGNING_PRIVATE_KEY === "synthetic-private-signing-material"
  }));
  return { exitCode: 0 };
};\n`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      preload,
      join(import.meta.dir, "../desktop/scripts/build-shell-update.ts"),
      "--bundles",
      "app",
    ],
    {
      env: {
        ...process.env,
        OPENBOT_BUILD_CAPTURE: capture,
        OPENBOT_SHELL_UPDATE_PUBLIC_KEY: "synthetic-public-signing-key",
        OPENBOT_SHELL_UPDATE_ENDPOINT: "https://updates.example/latest.json",
        TAURI_SIGNING_PRIVATE_KEY: "synthetic-private-signing-material",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(0);
  const build = JSON.parse(readFileSync(capture, "utf8"));
  const configuration = build.argv
    .filter((argument: string) => argument.startsWith("{"))
    .map((argument: string) => JSON.parse(argument))
    .find(
      (config: { plugins?: { updater?: object } }) => config.plugins?.updater,
    );
  expect(configuration?.plugins.updater).toEqual({
    pubkey: "synthetic-public-signing-key",
    endpoints: ["https://updates.example/latest.json"],
  });
  expect(build.argv).toContain("app");
  expect(build.privateKeyAvailable).toBe(true);
  expect(JSON.stringify(build.argv)).not.toContain(
    "synthetic-private-signing-material",
  );
});

type WorkflowStep = {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};
type WorkflowJob = {
  needs?: string | string[];
  environment?: string;
  steps: WorkflowStep[];
};
/*
 * GitHub matches an environment's deployment branch and tag rule against the run's GITHUB_REF,
 * which for workflow_dispatch is the ref the run was dispatched from. A free `source-ref` input
 * let any branch dispatch sign any other code with the private key.
 */
test("signed shell builds sign only the dispatched tag the protected environment vetted", () => {
  const source = readFileSync(
    join(import.meta.dir, "../.github/workflows/desktop-shell-updates.yml"),
    "utf8",
  );
  const workflow = Bun.YAML.parse(source) as {
    on: { workflow_dispatch: { inputs?: unknown } | null };
    jobs: Record<string, WorkflowJob>;
  };
  expect(workflow.on.workflow_dispatch?.inputs).toBeUndefined();
  expect(source).not.toContain("inputs.");

  const signing = workflow.jobs["signed-artifacts"];
  expect(signing?.environment).toBe("desktop-shell-signing");
  const checkouts = (signing?.steps ?? []).filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkouts).toHaveLength(1);
  for (const checkout of checkouts)
    expect(checkout.with?.ref).toBe(["$", "{{ github.sha }}"].join(""));

  // The tag check runs first, in a job that holds neither the environment nor its secrets.
  const needs = [signing?.needs ?? []].flat();
  expect(needs).toHaveLength(1);
  const gate = workflow.jobs[needs[0] ?? ""];
  expect(gate?.environment).toBeUndefined();
  expect(JSON.stringify(gate)).not.toContain("secrets.");
  const script = gate?.steps.find((step) => step.run)?.run ?? "";
  for (const [ref, type, allowed] of [
    ["refs/tags/v0.3.0", "tag", true],
    ["refs/heads/main", "branch", false],
    ["refs/heads/v0.3.0", "branch", false],
    ["refs/pull/12/merge", "branch", false],
  ] as const) {
    const run = Bun.spawnSync(["bash", "-e", "-c", script], {
      env: {
        PATH: process.env.PATH ?? "",
        DISPATCHED_REF: ref,
        DISPATCHED_REF_TYPE: type,
        GITHUB_SHA: "3333333333333333333333333333333333333333",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ ref, allowed: run.exitCode === 0 }).toEqual({ ref, allowed });
  }
});

test("official and fork desktop identities conform to actual publisher defaults", () => {
  const root = join(import.meta.dir, "..");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const fixture: {
    name: string;
    repository?: string;
    distributionId?: string;
    channel?: string;
    expected: { id: string; repository: string; channel: string };
  }[] = JSON.parse(
    readFileSync(
      join(root, "desktop/src-tauri/test-fixtures/publisher-distribution.json"),
      "utf8",
    ),
  );
  const manifest = JSON.parse(
    readFileSync(join(root, "shared/fixtures/releases/candidate.json"), "utf8"),
  );
  for (const vector of fixture) {
    const configured = {
      OPENBOT_RELEASE_REPOSITORY: vector.repository,
      OPENBOT_DISTRIBUTION_ID: vector.distributionId,
      OPENBOT_RELEASE_CHANNEL: vector.channel,
    };
    const producer = readReleaseConfiguration(
      {
        ...configured,
        GITHUB_REPOSITORY: vector.repository ?? vector.expected.repository,
        GITHUB_SHA: commit,
        VERSION: "v0.3.0",
        OPENBOT_UPSTREAM_COMMIT: commit,
        OPENBOT_RELEASE_POLICY: JSON.stringify({
          compatibility: manifest.compatibility,
          upgrade: manifest.upgrade,
        }),
      },
      root,
    );
    expect({
      id: producer.distributionId,
      repository: producer.repository,
      channel: producer.channel,
    }).toEqual(vector.expected);
    expect(shellDistribution(configured)).toEqual(vector.expected);
  }
  const githubExpression = (value: string) =>
    ["$", "{{ ", value, " }}"].join("");
  for (const file of ["desktop.yml", "desktop-signing.yml"]) {
    const workflow = readFileSync(
      join(root, ".github/workflows", file),
      "utf8",
    );
    expect(workflow).toContain(
      `OPENBOT_DISTRIBUTION_ID: ${githubExpression("vars.OPENBOT_DISTRIBUTION_ID || github.repository")}`,
    );
    expect(workflow).toContain(
      `OPENBOT_RELEASE_REPOSITORY: ${githubExpression("github.repository")}`,
    );
    expect(workflow).toContain(
      `OPENBOT_RELEASE_CHANNEL: ${githubExpression("vars.OPENBOT_RELEASE_CHANNEL || 'stable'")}`,
    );
  }
});
