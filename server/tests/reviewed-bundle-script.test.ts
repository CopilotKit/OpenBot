import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/create-reviewed-bundle.sh",
);

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

function temporaryRepository() {
  const directory = mkdtempSync(join(tmpdir(), "openbot-bundle-script-"));
  run(["git", "init", "-q"], directory);
  run(["git", "config", "user.email", "bundle@test"], directory);
  run(["git", "config", "user.name", "Bundle Test"], directory);
  writeFileSync(join(directory, "reviewed.txt"), "reviewed\n");
  run(["git", "add", "reviewed.txt"], directory);
  run(["git", "commit", "-qm", "reviewed"], directory);
  return directory;
}

test("creates a verified bundle with a temporary advertised ref at the reviewed commit", () => {
  const repository = temporaryRepository();
  const bundle = join(repository, "reviewed.bundle");
  try {
    const target = run(["git", "rev-parse", "HEAD"], repository);
    const result = Bun.spawnSync(["bash", scriptPath, target, bundle], {
      cwd: repository,
    });

    expect(result.exitCode).toBe(0);
    const [reportedBundle, reportedHash] = result.stdout
      .toString()
      .trim()
      .split(" ");
    expect(reportedBundle).toBe(bundle);
    expect(reportedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      Bun.spawnSync(["git", "bundle", "verify", bundle], { cwd: repository })
        .exitCode,
    ).toBe(0);
    expect(run(["git", "bundle", "list-heads", bundle], repository)).toBe(
      `${target} refs/netsfera-review/${target}`,
    );
    expect(
      Bun.spawnSync(
        ["git", "show-ref", "--verify", `refs/netsfera-review/${target}`],
        {
          cwd: repository,
        },
      ).exitCode,
    ).not.toBe(0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("rejects an invalid target without leaving a bundle or advertised ref", () => {
  const repository = temporaryRepository();
  const bundle = join(repository, "invalid.bundle");
  const target = "not-a-commit";
  try {
    const result = Bun.spawnSync(["bash", scriptPath, target, bundle], {
      cwd: repository,
    });

    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(bundle)).toThrow();
    expect(
      Bun.spawnSync(
        ["git", "show-ref", "--verify", `refs/netsfera-review/${target}`],
        {
          cwd: repository,
        },
      ).exitCode,
    ).not.toBe(0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
