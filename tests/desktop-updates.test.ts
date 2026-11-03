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
