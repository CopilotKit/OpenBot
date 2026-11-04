import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The upgrade policy is reviewed with the release it describes: it lives in the tree, is read from
// the release commit, and is refused unless it names the version being released.

const root = join(import.meta.dir, "..");
const cli = join(root, "scripts/release-manifest.ts");
const policy = JSON.parse(
  readFileSync(join(root, "release-policy.json"), "utf8"),
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function validate(cwd: string, env: Record<string, string>) {
  const run = Bun.spawnSync([process.execPath, cli, "--validate-policy"], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, output: `${run.stdout}${run.stderr}` };
}
/** The upstream repository publishing a release, with the given policy committed. */
function publisher(committed: unknown) {
  const repo = mkdtempSync(join(tmpdir(), "openbot-policy-"));
  directories.push(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "core.txt"), "release\n");
  if (committed !== undefined)
    writeFileSync(
      join(repo, "release-policy.json"),
      `${JSON.stringify(committed, null, 2)}\n`,
    );
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.test",
    "commit",
    "-m",
    "release",
  );
  return {
    repo,
    env: {
      GITHUB_REPOSITORY: "CopilotKit/OpenBot",
      GITHUB_SHA: git(repo, "rev-parse", "HEAD"),
      VERSION: "v0.4.0",
    },
  };
}
const forVersion = (version: string, fromVersions = ["v0.3.0"]) => ({
  ...policy,
  version,
  upgrade: { ...policy.upgrade, fromVersions },
});

describe("release policy", () => {
  test("the committed policy passes the release preflight for the version it names", () => {
    const result = validate(root, {
      GITHUB_REPOSITORY: "CopilotKit/OpenBot",
      GITHUB_SHA: git(root, "rev-parse", "HEAD"),
      VERSION: policy.version,
    });
    expect(result).toEqual({
      exitCode: 0,
      output: expect.stringContaining(`describes ${policy.version}`),
    });
  });

  test("the committed policy is for this release or the next one, never an earlier one", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(
      Bun.semver.order(policy.version, `v${pkg.version}`),
    ).toBeGreaterThanOrEqual(0);
    expect(policy.upgrade.fromVersions.length).toBeGreaterThan(0);
  });

  test("the committed policy names its schema, and the schema's references resolve", () => {
    const schemaPath = join(root, policy.$schema);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.required).toEqual(["version", "compatibility", "upgrade"]);
    const refs = JSON.stringify(schema).match(/"\$ref":"([^"]+)"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const [file, pointer] = ref.slice(8, -1).split("#");
      const target = JSON.parse(
        readFileSync(join(dirname(schemaPath), file!), "utf8"),
      );
      const resolved = pointer!
        .split("/")
        .slice(1)
        .reduce((node, key) => node?.[key], target);
      expect(resolved).toBeDefined();
    }
  });

  test("a policy left over from the previous release is refused, and says why", () => {
    const { repo, env } = publisher(forVersion("v0.3.0", ["v0.2.0"]));
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'release-policy.json describes "v0.3.0", but this release is v0.4.0',
    );
  });

  test("a policy written for this release passes", () => {
    const { repo, env } = publisher(forVersion("v0.4.0"));
    expect(validate(repo, env).exitCode).toBe(0);
  });

  test("a repository variable cannot stand in for the committed policy", () => {
    const { repo, env } = publisher(forVersion("v0.3.0", ["v0.2.0"]));
    const result = validate(repo, {
      ...env,
      OPENBOT_RELEASE_POLICY: JSON.stringify(forVersion("v0.4.0")),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('describes "v0.3.0"');
  });

  test("the policy is read from the release commit, not the working tree", () => {
    const { repo, env } = publisher(forVersion("v0.3.0", ["v0.2.0"]));
    writeFileSync(
      join(repo, "release-policy.json"),
      JSON.stringify(forVersion("v0.4.0")),
    );
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      'release-policy.json describes "v0.3.0", but this release is v0.4.0',
    );
  });

  test("a release commit without a policy is refused", () => {
    const { repo, env } = publisher(undefined);
    expect(existsSync(join(repo, "release-policy.json"))).toBe(false);
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("has no release-policy.json");
  });

  test.each([
    [
      "names this version as a starting version",
      forVersion("v0.4.0", ["v0.4.0"]),
      "is not earlier than v0.4.0",
    ],
    [
      "names a later starting version",
      forVersion("v0.4.0", ["v0.5.0"]),
      "is not earlier than v0.4.0",
    ],
    [
      "names something that is not a release",
      forVersion("v0.4.0", ["latest"]),
      "is not a release version",
    ],
    [
      "carries an unknown field",
      { ...forVersion("v0.4.0"), notes: "x" },
      "unsupported fields: notes",
    ],
    [
      "promises a restart onto a database the previous release cannot read",
      {
        ...forVersion("v0.4.0"),
        upgrade: {
          ...forVersion("v0.4.0").upgrade,
          recovery: "restart-previous",
        },
      },
      "incompatible database requires restore-backup",
    ],
  ])("refuses a policy that %s", (_name, committed, reason) => {
    const { repo, env } = publisher(committed);
    const result = validate(repo, env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(reason);
  });
});
