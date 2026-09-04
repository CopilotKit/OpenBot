import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wrapperPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/verify-reviewed-promotion-wrapper.sh",
);

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-promotion-wrapper-"));
  const source = join(root, "source");
  const incoming = join(root, "incoming");
  const marker = join(root, "marker");
  run(["mkdir", source, incoming], root);
  run(["git", "init", "-q"], source);
  run(["git", "config", "user.email", "wrapper@test"], source);
  run(["git", "config", "user.name", "Wrapper Test"], source);
  writeFileSync(join(source, "base.txt"), "base\n");
  run(["git", "add", "."], source);
  run(["git", "commit", "-qm", "base"], source);
  run(["mkdir", "-p", join(source, "deploy/netsfera")], source);
  const reviewedScript =
    '#!/usr/bin/env bash\nprintf reviewed > "$WRAPPER_MARKER"\n';
  const relativePath = "deploy/netsfera/promote-reviewed-g0.sh";
  writeFileSync(join(source, relativePath), reviewedScript);
  chmodSync(join(source, relativePath), 0o755);
  run(["git", "add", "."], source);
  run(["git", "commit", "-qm", "reviewed"], source);
  const target = run(["git", "rev-parse", "HEAD"], source);
  const advertisedRef = `refs/netsfera-review/${target}`;
  const bundle = join(incoming, "reviewed.bundle");
  const transferred = join(incoming, "promote-reviewed-g0.sh");
  run(["git", "update-ref", advertisedRef, target], source);
  run(["git", "bundle", "create", bundle, advertisedRef], source);
  run(["git", "update-ref", "-d", advertisedRef], source);
  writeFileSync(transferred, reviewedScript);
  chmodSync(transferred, 0o700);
  return {
    root,
    source,
    incoming,
    marker,
    target,
    advertisedRef,
    bundle,
    transferred,
    bundleHash: run(["sha256sum", bundle], root).split(" ")[0],
  };
}

function invoke(input: ReturnType<typeof fixture>) {
  return Bun.spawnSync(
    [
      "bash",
      wrapperPath,
      input.bundle,
      input.bundleHash,
      input.advertisedRef,
      input.target,
      input.transferred,
    ],
    {
      env: {
        ...process.env,
        OPENBOT_SOURCE_DIR: input.source,
        WRAPPER_MARKER: input.marker,
      },
    },
  );
}

test("executes transferred promotion bytes only when they match the verified reviewed blob", () => {
  const input = fixture();
  try {
    const result = invoke(input);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(input.marker, "utf8")).toBe("reviewed");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("refuses changed transferred promotion bytes before they execute", () => {
  const input = fixture();
  try {
    writeFileSync(
      input.transferred,
      '#!/usr/bin/env bash\nprintf tampered > "$WRAPPER_MARKER"\n',
    );
    const result = invoke(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "reviewed promotion script bytes do not match",
    );
    expect(() => readFileSync(input.marker)).toThrow();
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});
