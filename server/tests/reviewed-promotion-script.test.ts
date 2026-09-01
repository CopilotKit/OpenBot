import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(import.meta.dir, "../../deploy/netsfera/promote-reviewed-g0.sh");

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

test("rejects a mismatched reviewed-bundle digest before changing the source checkout", () => {
  const source = mkdtempSync(join(tmpdir(), "openbot-promotion-source-"));
  const incoming = mkdtempSync(join(tmpdir(), "openbot-promotion-incoming-"));
  const bundle = join(incoming, "reviewed.bundle");
  try {
    run(["git", "init", "-q"], source);
    run(["git", "config", "user.email", "promotion@test"], source);
    run(["git", "config", "user.name", "Promotion Test"], source);
    writeFileSync(join(source, "reviewed.txt"), "reviewed\n");
    run(["git", "add", "reviewed.txt"], source);
    run(["git", "commit", "-qm", "reviewed"], source);
    const originalHead = run(["git", "rev-parse", "HEAD"], source);
    run(["git", "bundle", "create", bundle, "HEAD"], source);
    chmodSync(bundle, 0o600);

    const result = Bun.spawnSync(["bash", scriptPath, bundle, "0".repeat(64), "HEAD", originalHead], {
      env: {
        ...process.env,
        OPENBOT_SOURCE_DIR: source,
        OPENBOT_INCOMING_DIR: incoming,
        OPENBOT_EXPECTED_BUNDLE_OWNER: `${process.env.USER ?? "xavi-mac"}:staff`,
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("reviewed bundle SHA-256 mismatch");
    expect(run(["git", "rev-parse", "HEAD"], source)).toBe(originalHead);
    expect(readFileSync(join(source, "reviewed.txt"), "utf8")).toBe("reviewed\n");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(incoming, { recursive: true, force: true });
  }
});
