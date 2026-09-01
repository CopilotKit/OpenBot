import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(import.meta.dir, "../../deploy/netsfera/promote-reviewed-g0.sh");

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
  run(["mkdir", source, incoming, fakeBin], root);
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

  makeExecutable(join(fakeBin, "jq"), "#!/usr/bin/env bash\nprintf '%s\\n' openbot:test\n");
  makeExecutable(join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  makeExecutable(join(fakeBin, "docker"), `#!/usr/bin/env bash
set -eu
printf 'docker %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = compose ]; then
  joined=" $* "
  case "$joined" in
    *" exec "*) exit 0 ;;
    *" config "*) printf '%s\\n' '{"services":{"openbot":{"image":"openbot:test"}}}'; exit 0 ;;
    *" build openbot "*) [ "\${FAKE_FAIL_MODE:-}" = after-build ] && exit 44; exit 0 ;;
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
    if [ "$last" = new ] && [ "\${FAKE_FAIL_MODE:-}" = after-apply ]; then printf unhealthy; else printf healthy; fi
  elif [[ "$format" == *Image* ]]; then
    [ "$last" = old ] && printf sha256:old || printf sha256:new
  fi
  exit 0
fi
[ "$1" = run ] && exit 0
exit 0
`);

  const bundleHash = run(["sha256sum", bundle], root).split(" ")[0];
  const owner = `${run(["id", "-un"], root)}:${run(["id", "-gn"], root)}`;
  return {
    root, source, incoming, bundle, target, original, advertisedRef, bundleHash, fakeBin, log, state, owner,
  };
}

function execute(fixture: ReturnType<typeof promotionFixture>, failMode?: string) {
  return Bun.spawnSync(
    ["bash", scriptPath, fixture.bundle, fixture.bundleHash, fixture.advertisedRef, fixture.target],
    {
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:/opt/homebrew/bin:/usr/bin:/bin:/sbin`,
        FAKE_LOG: fixture.log,
        FAKE_STATE: fixture.state,
        ...(failMode ? { FAKE_FAIL_MODE: failMode } : {}),
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
    const evidence = readdirSync(fixture.incoming).filter((name) => name.endsWith(".evidence"));
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(fixture.incoming, evidence[0]), "utf8")).toContain(`target_commit=${fixture.target}`);
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
