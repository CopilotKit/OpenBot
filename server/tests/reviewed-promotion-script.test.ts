import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(import.meta.dir, "../../deploy/netsfera/promote-reviewed-g0.sh");
const lockedHelperPath = resolve(import.meta.dir, "../../deploy/netsfera/openbot-compose-lock-v1.sh");
const realGit = Bun.which("git")!;

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}

function makeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function promotionFixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-promotion-"));
  const source = join(root, "source");
  const incoming = join(root, "incoming");
  const fakeBin = join(root, "bin");
  const log = join(root, "commands.log");
  const state = join(root, "state");
  const cleanupCounter = join(root, "cleanup-counter");
  run(["mkdir", source, incoming, fakeBin], root);
  makeExecutable(join(fakeBin, "openbot-compose-v1.sh"), `#!/bin/sh
printf 'helper %s\\n' "$*" >>"$FAKE_LOG"
exec "$LOCKED_HELPER" "$@"
`);
  run(["git", "init", "-q"], source);
  run(["git", "config", "user.email", "promotion@test"], source);
  run(["git", "config", "user.name", "Promotion Test"], source);
  writeFileSync(join(source, "reviewed.txt"), "original\n");
  run(["git", "add", "reviewed.txt"], source);
  run(["git", "commit", "-qm", "original"], source);
  const original = run(["git", "rev-parse", "HEAD"], source);
  run(["mkdir", "-p", join(source, "deploy/netsfera")], source);
  makeExecutable(join(source, "deploy/netsfera/verify-rendered-overlay.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(source, "reviewed.txt"), "reviewed\n");
  run(["git", "add", "."], source);
  run(["git", "commit", "-qm", "reviewed"], source);
  const target = run(["git", "rev-parse", "HEAD"], source);
  const advertisedRef = `refs/netsfera-review/${target}`;
  const bundle = join(incoming, "reviewed.bundle");
  run(["git", "update-ref", advertisedRef, target], source);
  run(["git", "bundle", "create", bundle, advertisedRef], source);
  run(["git", "update-ref", "-d", advertisedRef], source);
  run(["git", "checkout", "--detach", original], source);
  chmodSync(bundle, 0o600);

  makeExecutable(join(fakeBin, "jq"), "#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s\\n' openbot:test\n");
  makeExecutable(join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  makeExecutable(join(fakeBin, "rm"), `#!/usr/bin/env bash
if [[ "\${FAKE_FAIL_MODE:-}" == *cleanup-failure* ]] && [[ "$*" == *g0-promotion* ]]; then
  printf 'simulated cleanup failure\\n' >&2
  exit 55
fi
if [[ "\${FAKE_FAIL_MODE:-}" == *cleanup-first-failure* ]] && [[ "$*" == *g0-promotion* ]] && [ ! -e "$FAKE_CLEANUP_COUNTER" ]; then
  : > "$FAKE_CLEANUP_COUNTER"
  printf 'simulated first cleanup failure\\n' >&2
  exit 55
fi
exec /bin/rm "$@"
`);
  makeExecutable(join(fakeBin, "git"), `#!/usr/bin/env bash
if [[ "\${FAKE_FAIL_MODE:-}" == *rollback-status* ]] && [ "$1" = -C ] && [ "$3" = status ] && [ "$("$REAL_GIT" -C "$2" rev-parse HEAD)" = "$FAKE_ORIGINAL" ]; then
  printf 'simulated rollback status failure\\n' >&2
  exit 41
fi
exec "$REAL_GIT" "$@"
`);
  makeExecutable(join(fakeBin, "docker"), `#!/usr/bin/env bash
set -eu
printf 'docker %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = compose ]; then
  joined=" $* "
  case "$joined" in
    *" exec "*)
      case "\${FAKE_FAIL_MODE:-}" in
        skill-grant) [[ "$*" == *"kind <> 'skill'"* ]] || printf 'recolector-documentos\\tskill\\tpersonal-provider\\n';;
        mcp-grant|bot-grant) printf 'recolector-documentos\\t%s\\tforbidden\\n' "\${FAKE_FAIL_MODE%-grant}";;
      esac
      exit 0 ;;
    *" config "*) printf '%s\\n' '{"services":{"openbot":{"image":"openbot:test"}}}'; exit 0 ;;
    *" build openbot "*) [[ "\${FAKE_FAIL_MODE:-}" == *after-build* ]] && exit 44; exit 0 ;;
    *" up -d "*) case "$joined" in *candidate.json*) printf applied > "$FAKE_STATE" ;; esac; exit 0 ;;
    *" ps -q openbot "*) case "$joined" in *candidate.json*) printf new ;; *) printf old ;; esac; exit 0 ;;
  esac
fi
if [ "$1" = image ] && [ "$2" = tag ]; then
  [ "\${3:-}" != "" ] && case "$3" in *g0-rollback-*) printf restored > "$FAKE_STATE" ;; esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "\${!#}" in *g0-rollback-*) exit 1 ;; esac
  [ -f "$FAKE_STATE" ] && [ "$(cat "$FAKE_STATE")" = restored ] && printf 'sha256:old' || printf 'sha256:new'
  exit 0
fi
if [ "$1" = inspect ]; then
  last="\${!#}"
  format="\${3:-}"
  if [[ "$format" == *Health* ]]; then
    if [ "$last" = new ] && [[ "\${FAKE_FAIL_MODE:-}" == *after-apply* ]]; then printf unhealthy; else printf healthy; fi
  elif [[ "$format" == *Image* ]]; then
    [ "$last" = old ] && printf sha256:old || printf sha256:new
  fi
  exit 0
fi
if [ "$1" = run ]; then
  case "\${FAKE_IMAGE_BRAND:-product-and-tenant}" in
    product-only)
      [[ "$*" == *'grep -R -F -q "netsfera"'* ]] && exit 42
      ;;
    wrong-product)
      [[ "$*" == *--entrypoint* ]] && exit 43
      ;;
  esac
  exit 0
fi
exit 0
`);

  const bundleHash = run(["sha256sum", bundle], root).split(" ")[0];
  const owner = `${run(["id", "-un"], root)}:${run(["id", "-gn"], root)}`;
  return {
    root, source, incoming, bundle, target, original, advertisedRef, bundleHash, fakeBin, log, state, cleanupCounter, owner,
  };
}

function execute(
  fixture: ReturnType<typeof promotionFixture>,
  failMode?: string,
  imageBrand?: "product-only" | "wrong-product",
) {
  return Bun.spawnSync(
    ["bash", scriptPath, fixture.bundle, fixture.bundleHash, fixture.advertisedRef, fixture.target],
    {
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:/opt/homebrew/bin:/usr/bin:/bin:/sbin`,
        FAKE_LOG: fixture.log,
        FAKE_STATE: fixture.state,
        FAKE_CLEANUP_COUNTER: fixture.cleanupCounter,
        FAKE_ORIGINAL: fixture.original,
        REAL_GIT: realGit,
        LOCKED_HELPER: lockedHelperPath,
        OPENBOT_COMPOSE_HELPER: join(fixture.fakeBin, "openbot-compose-v1.sh"),
        OPENBOT_DEPLOYMENT_LOCK_FILE: join(fixture.root, "deployment.lock"),
        OPENBOT_G1_ACTIVATION_MANIFEST: join(fixture.root, "activation.manifest"),
        OPENBOT_G1_ACTIVATION_MARKER: join(fixture.root, "activation.marker"),
        ...(failMode ? { FAKE_FAIL_MODE: failMode } : {}),
        ...(imageBrand ? { FAKE_IMAGE_BRAND: imageBrand } : {}),
        OPENBOT_SOURCE_DIR: fixture.source,
        OPENBOT_INCOMING_DIR: fixture.incoming,
        OPENBOT_EXPECTED_BUNDLE_OWNER: fixture.owner,
        OPENBOT_BASE_ENV_FILE: "/unused/base.env",
        OPENBOT_PHASE2_ENV_FILE: "/unused/phase2.env",
        OPENBOT_BASE_COMPOSE_FILE: "/unused/base.yml",
        OPENBOT_SUPERVISOR_COMPOSE_FILE: "/unused/supervisor.yml",
        OPENBOT_PHASE2_COMPOSE_FILE: "/unused/phase2.yml",
      },
    },
  );
}

function expectScopedUpCommands(log: string) {
  const upCommands = log.split("\n").filter((line) => line.includes(" up -d "));
  expect(upCommands.length).toBeGreaterThan(0);
  for (const command of upCommands) {
    expect(command).toContain("--no-deps");
    expect(command).toContain("--no-build");
    expect(command).toMatch(/ openbot$/);
  }
}

test.each(["skill-grant", "mcp-grant", "bot-grant"])("promotion permits only instruction grants: %s", (grant) => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, grant);
    if (grant === "skill-grant") expect(result.exitCode, result.stderr.toString()).toBe(0);
    else {
      expect(result.exitCode).toBe(65);
      expect(run(["git", "rev-parse", "HEAD"], fixture.source)).toBe(fixture.original);
      expect(readFileSync(fixture.log, "utf8")).not.toContain(" build openbot");
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("rejects a mismatched reviewed-bundle digest before changing the source checkout", () => {
  const fixture = promotionFixture();
  try {
    const result = Bun.spawnSync(["bash", scriptPath, fixture.bundle, "0".repeat(64), fixture.advertisedRef, fixture.target], {
      env: { ...process.env, OPENBOT_SOURCE_DIR: fixture.source, OPENBOT_INCOMING_DIR: fixture.incoming },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("reviewed bundle SHA-256 mismatch");
    expect(run(["git", "rev-parse", "HEAD"], fixture.source)).toBe(fixture.original);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("promotes only openbot from the exact candidate render and keeps unique evidence", () => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture);
    expect(result.exitCode).toBe(0);
    expect(run(["git", "rev-parse", "HEAD"], fixture.source)).toBe(fixture.target);
    expectScopedUpCommands(readFileSync(fixture.log, "utf8"));
    expect(readFileSync(fixture.log, "utf8")).toContain("helper --lock-held-fd 9 --reviewed-controller");
    const commands = readFileSync(fixture.log, "utf8").split("\n");
    expect(commands.filter((line) => line.startsWith("helper ")).length)
      .toBe(commands.filter((line) => line.startsWith("docker compose ")).length);
    const evidence = readdirSync(fixture.incoming).filter((name) => name.endsWith(".evidence"));
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(fixture.incoming, evidence[0]), "utf8")).toContain(`target_commit=${fixture.target}`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("accepts the baked NETSFERA ERP product even when Vite removed unused tenantId", () => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, undefined, "product-only");
    expect(result.exitCode).toBe(0);
    expect(run(["git", "rev-parse", "HEAD"], fixture.source)).toBe(fixture.target);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a baked image without the exact NETSFERA ERP product and rolls back", () => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, undefined, "wrong-product");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("restoring recorded OpenBot source and image");
    expect(run(["git", "rev-parse", "HEAD"], fixture.source)).toBe(fixture.original);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test.each(["after-build", "after-apply"])("rolls back and verifies the prior service after %s failure", (failure) => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, failure);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("restoring recorded OpenBot source and image");
    expect(run(["git", "rev-parse", "HEAD"], fixture.source)).toBe(fixture.original);
    expectScopedUpCommands(readFileSync(fixture.log, "utf8"));
    expect(readFileSync(fixture.state, "utf8")).toBe("restored");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("attempts rollback even when private cleanup fails", () => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, "after-build,cleanup-failure");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("restoring recorded OpenBot source and image");
    expect(readFileSync(fixture.state, "utf8")).toBe("restored");
    expectScopedUpCommands(readFileSync(fixture.log, "utf8"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reports cleanup failure after a successful promotion when the first cleanup removal fails", () => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, "cleanup-first-failure");
    expect(result.exitCode).toBe(71);
    expect(result.stderr.toString()).toContain("promotion cleanup failed after rollback");
    expect(readFileSync(fixture.state, "utf8")).toBe("applied");
    expectScopedUpCommands(readFileSync(fixture.log, "utf8"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reports CRITICAL and exits 70 when rollback status verification fails", () => {
  const fixture = promotionFixture();
  try {
    const result = execute(fixture, "after-build,rollback-status");
    expect(result.exitCode).toBe(70);
    expect(result.stderr.toString()).toContain("CRITICAL: automatic rollback is incomplete");
    expectScopedUpCommands(readFileSync(fixture.log, "utf8"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not overwrite evidence or rollback tags on a retry", () => {
  const fixture = promotionFixture();
  try {
    expect(execute(fixture).exitCode).toBe(0);
    const firstEvidence = readdirSync(fixture.incoming).filter((name) => name.endsWith(".evidence"));
    run(["git", "update-ref", fixture.advertisedRef, fixture.target], fixture.source);
    run(["git", "bundle", "create", fixture.bundle, fixture.advertisedRef], fixture.source);
    run(["git", "update-ref", "-d", fixture.advertisedRef], fixture.source);
    chmodSync(fixture.bundle, 0o600);
    expect(execute(fixture).exitCode).toBe(0);
    const evidence = readdirSync(fixture.incoming).filter((name) => name.endsWith(".evidence"));
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence).size).toBe(2);
    expect(firstEvidence[0]).not.toBe(evidence.find((name) => name !== firstEvidence[0]));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
