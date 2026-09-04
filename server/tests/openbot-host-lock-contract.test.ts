import { expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const helperPath = join(repoRoot, "deploy/netsfera/openbot-compose-lock-v1.sh");
const wrapperPath = join(
  repoRoot,
  "deploy/netsfera/verify-reviewed-host-lock-wrapper.sh",
);
const installerPath = join(
  repoRoot,
  "deploy/netsfera/install-openbot-lock-contract.sh",
);

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(command, { cwd, env: { ...process.env, ...env } });
}

function helperFixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-host-lock-helper-"));
  const bin = join(root, "bin");
  const log = join(root, "compose.log");
  const lock = join(root, "deployment.lock");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(lock, "", { mode: 0o600 });
  executable(
    join(bin, "docker"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$COMPOSE_LOG"\n',
  );
  const env = {
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    COMPOSE_LOG: log,
    OPENBOT_DEPLOYMENT_LOCK_FILE: lock,
    OPENBOT_PHASE2_MARKER: join(root, "absent-marker"),
    OPENBOT_BASE_COMPOSE_FILE: join(root, "docker-compose.yml"),
  };
  return { root, log, lock, env };
}

test("every public helper operation takes the shared deployment lock", async () => {
  const input = helperFixture();
  try {
    const holder = Bun.spawn(
      ["bash", "-c", 'exec 8>"$LOCK"; flock -n 8; printf ready; sleep 10'],
      { env: { ...process.env, LOCK: input.lock }, stdout: "pipe" },
    );
    await Bun.sleep(100);
    for (const args of [
      ["config", "--quiet"],
      ["up", "--detach"],
      ["restart", "openbot"],
      ["stop", "openbot"],
      ["down"],
      ["run", "--rm", "openbot", "true"],
    ]) {
      const result = run(["bash", helperPath, ...args], input.root, input.env);
      expect(result.exitCode).toBe(75);
      expect(result.stderr.toString()).toContain("deployment lock is held");
    }
    expect(readFileSync(input.log, "utf8")).toBe("");
    holder.kill();
    await holder.exited;
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("controller interface requires an inherited lock and cannot mutate an active deployment", () => {
  const input = helperFixture();
  const manifest = join(input.root, "activation.manifest");
  try {
    const withoutFD = run(["bash", helperPath, "--reviewed-controller", "config", "--format", "json"], input.root, input.env);
    expect(withoutFD.exitCode).toBe(64);
    writeFileSync(manifest, "active\n", { mode: 0o600 });
    for (const args of ["build openbot", "up --detach", "exec postgres true", "run --rm openbot true", "restart openbot"]) {
      const blocked = run(["bash", "-c", 'exec 9>"$OPENBOT_DEPLOYMENT_LOCK_FILE"; flock -n 9; "$HELPER" --lock-held-fd 9 --reviewed-controller -f /candidate.yml ' + args], input.root,
        { ...input.env, HELPER: helperPath, OPENBOT_G1_ACTIVATION_MANIFEST: manifest });
      expect(blocked.exitCode).toBe(65);
    }
    expect(readFileSync(input.log, "utf8")).toBe("");
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("an inherited FD avoids relocking only when it names and holds the exact lock", () => {
  const input = helperFixture();
  try {
    const accepted = run(
      [
        "bash",
        "-c",
        'umask 077; exec 9>"$OPENBOT_DEPLOYMENT_LOCK_FILE"; flock -n 9; exec "$HELPER" --lock-held-fd 9 config --quiet',
      ],
      input.root,
      { ...input.env, HELPER: helperPath },
    );
    expect(accepted.exitCode).toBe(0);
    expect(readFileSync(input.log, "utf8")).toContain("compose");

    writeFileSync(input.log, "");
    const rejected = run(
      [
        "bash",
        "-c",
        'exec 9>"$OTHER"; flock -n 9; exec "$HELPER" --lock-held-fd 9 down',
      ],
      input.root,
      {
        ...input.env,
        HELPER: helperPath,
        OTHER: join(input.root, "other.lock"),
      },
    );
    expect(rejected.exitCode).toBe(65);
    expect(rejected.stderr.toString()).toContain(
      "inherited deployment lock FD",
    );
    expect(readFileSync(input.log, "utf8")).toBe("");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("an independently opened FD cannot borrow another process's lock", async () => {
  const input = helperFixture();
  const ready = join(input.root, "holder.ready");
  const holder = Bun.spawn(
    [
      "flock",
      "-n",
      input.lock,
      "sh",
      "-c",
      ': >"$READY"; while :; do sleep 1; done',
    ],
    { env: { ...process.env, READY: ready } },
  );
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
      await Bun.sleep(10);
    }
    expect(existsSync(ready)).toBe(true);
    const attacker = run(
      [
        "bash",
        "-c",
        'exec 9>"$OPENBOT_DEPLOYMENT_LOCK_FILE"; exec "$HELPER" --lock-held-fd 9 restart openbot',
      ],
      input.root,
      { ...input.env, HELPER: helperPath },
    );
    expect(attacker.exitCode).not.toBe(0);
    expect(attacker.stderr.toString()).toContain(
      "inherited deployment lock FD is not held",
    );
    expect(readFileSync(input.log, "utf8")).toBe("");
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("helper rejects unsafe lock files and inode replacement before Compose", () => {
  for (const mode of ["mode", "owner", "symlink", "swap"] as const) {
    const input = helperFixture();
    try {
      if (mode === "mode") chmodSync(input.lock, 0o644);
      if (mode === "owner") chownSync(input.lock, 1, 1);
      if (mode === "symlink") {
        rmSync(input.lock);
        const target = join(input.root, "target.lock");
        writeFileSync(target, "", { mode: 0o600 });
        symlinkSync(target, input.lock);
      }
      if (mode === "swap") {
        executable(
          join(input.root, "bin/flock"),
          `#!/bin/sh
/usr/bin/flock "$@" || exit $?
mv "$OPENBOT_DEPLOYMENT_LOCK_FILE" "$OPENBOT_DEPLOYMENT_LOCK_FILE.old"
: >"$OPENBOT_DEPLOYMENT_LOCK_FILE"
chmod 600 "$OPENBOT_DEPLOYMENT_LOCK_FILE"
`,
        );
      }
      const result = run(
        ["bash", helperPath, "restart", "openbot"],
        input.root,
        input.env,
      );
      expect(result.exitCode).toBe(65);
      expect(readFileSync(input.log, "utf8")).toBe("");
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  }
});

function hostFixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-host-lock-install-"));
  const source = join(root, "source");
  const packageDirectory = join(root, "package");
  const incoming = join(root, "incoming");
  const host = join(root, "host");
  const bin = join(root, "bin");
  const systemctlLog = join(root, "systemctl.log");
  mkdirSync(source);
  mkdirSync(join(source, ".git"));
  mkdirSync(packageDirectory);
  mkdirSync(incoming);
  mkdirSync(host);
  mkdirSync(bin);
  writeFileSync(systemctlLog, "");
  writeFileSync(join(root, "deployment.lock"), "", { mode: 0o600 });
  for (const name of [
    "install-openbot-lock-contract.sh",
    "openbot-compose-lock-v1.sh",
    "manage-openbot-g1-activation-v1.sh",
    "verify-openbot-lock-contract-v1.sh",
    "rollback-openbot-lock-contract-v1.sh",
    "netsfera-openbot-deployment-lock.conf",
  ]) {
    const sourcePath = join(repoRoot, "deploy/netsfera", name);
    writeFileSync(join(packageDirectory, name), readFileSync(sourcePath));
  }
  const target = "a".repeat(40);
  const advertisedRef = `refs/netsfera-review/${target}`;
  const bundle = join(incoming, "reviewed.bundle");
  const transferred = join(incoming, "install-openbot-lock-contract.sh");
  writeFileSync(bundle, "reviewed bundle\n", { mode: 0o600 });
  writeFileSync(transferred, readFileSync(installerPath), { mode: 0o700 });

  const liveHelper = join(host, "usr/local/lib/netsfera/openbot-compose-v1.sh");
  mkdirSync(join(host, "usr/local/lib/netsfera"), { recursive: true });
  writeFileSync(liveHelper, "#!/bin/sh\nprintf old-helper\\n\n", {
    mode: 0o700,
  });
  executable(
    join(bin, "systemctl"),
    `#!/bin/sh
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
if [ "\${FAIL_DAEMON_RELOAD:-0}" = 1 ] && [ "$*" = daemon-reload ]; then exit 23; fi
if [ "$*" = "cat netsfera-openbot.service" ]; then
  cat <<'EOF'
ExecStartPre=/usr/local/lib/netsfera/openbot-compose-v1.sh config --quiet
ExecStart=/usr/local/lib/netsfera/openbot-compose-v1.sh up --detach --remove-orphans
ExecStop=/usr/local/lib/netsfera/openbot-compose-v1.sh down
EOF
  if [ -f "$OPENBOT_HOST_ROOT/etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf" ]; then
    cat "$OPENBOT_HOST_ROOT/etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf"
  fi
fi
if [ "$1" = show ]; then
  case "$*" in
    *"--property=RefuseManualStop"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_REFUSE:-yes}";;
    *"--property=ExecStartPre"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_EXECSTARTPRE:-{ path=/usr/local/lib/netsfera/openbot-compose-v1.sh ; argv[]=/usr/local/lib/netsfera/openbot-compose-v1.sh config --quiet ; ignore_errors=no ; }}"; printf '%s\n' '{ path=/usr/local/lib/netsfera/assert-no-bootstrap-residue-v1.sh ; argv[]=/usr/local/lib/netsfera/assert-no-bootstrap-residue-v1.sh --directory /opt/openbot --compose docker-compose.yml --service bot-backend-ts --authkey /run/netsfera/bot-backend.authkey ; ignore_errors=no ; }';;
    *"--property=ExecStart"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_EXECSTART:-{ path=/usr/local/lib/netsfera/openbot-compose-v1.sh ; argv[]=/usr/local/lib/netsfera/openbot-compose-v1.sh up --detach --remove-orphans ; ignore_errors=no ; }}";;
    *"--property=ExecStop"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_EXECSTOP:-{ path=/usr/local/lib/netsfera/openbot-compose-v1.sh ; argv[]=/usr/local/lib/netsfera/openbot-compose-v1.sh down ; ignore_errors=no ; }}";;
    *"--property=Environment"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_ENVIRONMENT:-OPENBOT_DEPLOYMENT_LOCK_FILE=/var/lock/openbot-deployment.lock}";;
    *"--property=FragmentPath"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_FRAGMENT:-/etc/systemd/system/netsfera-openbot.service}";;
    *"--property=DropInPaths"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_DROPINS:-/etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf}";;
    *"--property=BindsTo"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_BINDSTO:-netsfera-docker-network-prepare.service netsfera-openbot-computer-network.service netsfera-openbot-computer-boundary.service}";;
    *"--property=Job"*)
      if [ -n "\${SYSTEMD_JOB_SEQUENCE_FILE:-}" ]; then
        count=$(cat "$SYSTEMD_JOB_SEQUENCE_FILE"); count=$((count + 1)); printf '%s\n' "$count" >"$SYSTEMD_JOB_SEQUENCE_FILE"
        if [ "$count" -eq 1 ]; then printf '%s\n' restart-job; fi
      else
        printf '%s\n' "\${SYSTEMD_EFFECTIVE_JOB:-}"
      fi;;
    *"--property=ActiveState"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_ACTIVE:-active}";;
    *"--property=SubState"*) printf '%s\n' "\${SYSTEMD_EFFECTIVE_SUB:-exited}";;
  esac
fi
`,
  );
  executable(
    join(bin, "install"),
    `#!/bin/sh
printf 'install %s\n' "$*" >>"$SYSTEMCTL_LOG"
exec /usr/bin/install "$@"
`,
  );
  executable(
    join(bin, "docker"),
    `#!/bin/sh
printf 'docker %s\n' "$*" >>"$SYSTEMCTL_LOG"
case "$*" in
  "ps --no-trunc --filter label=com.docker.compose.project=openbot --filter label=com.docker.compose.service=openbot --format {{.ID}}") printf '%064d\n' 1;;
  "ps --filter label=com.docker.compose.project=openbot --filter label=com.docker.compose.service=openbot --format {{.ID}}") printf '%012d\n' 1;;
  "inspect --format {{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}} "*)
    image=2
    if [ -n "\${RUNTIME_DRIFT_FILE:-}" ]; then
      count=$(cat "$RUNTIME_DRIFT_FILE"); count=$((count + 1)); printf '%s\n' "$count" >"$RUNTIME_DRIFT_FILE"
      if [ "$count" -gt 1 ]; then image=3; fi
    fi
    printf 'sha256:%064d|healthy\n' "$image";;
  *) exit 91;;
esac
`,
  );
  executable(
    join(bin, "git"),
    `#!/bin/sh
case " $* " in
  *" bundle verify "*) exit 0;;
  *" bundle list-heads "*) printf '%s %s\n' "$TARGET_COMMIT" "$ADVERTISED_REF";;
  *" fetch --no-tags "*) exit 0;;
  *" rev-parse refs/heads/host-lock-reviewed-artifact "*) printf '%s\n' "$TARGET_COMMIT";;
  *" rev-parse "*)
    value=""; for value do :; done
    name=\${value##*/}; printf 'blob-%s\n' "$name";;
  *" cat-file blob blob-"*)
    value=""; for value do :; done
    name=\${value#blob-}; cat "$PACKAGE_DIRECTORY/$name";;
  *) printf 'unexpected git call: %s\n' "$*" >&2; exit 92;;
esac
`,
  );
  const bundleHash = new Bun.CryptoHasher("sha256")
    .update(readFileSync(bundle))
    .digest("hex");
  const env = {
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
    OPENBOT_SOURCE_DIR: source,
    OPENBOT_INCOMING_DIR: incoming,
    OPENBOT_HOST_ROOT: host,
    OPENBOT_SYSTEMCTL: join(bin, "systemctl"),
    OPENBOT_EXPECTED_INSTALLER_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    OPENBOT_EXPECTED_ARTIFACT_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    OPENBOT_DEPLOYMENT_LOCK_FILE: join(root, "deployment.lock"),
    OPENBOT_LOCK_DRAIN_SLEEP_SECONDS: "0",
    SYSTEMCTL_LOG: systemctlLog,
    TARGET_COMMIT: target,
    ADVERTISED_REF: advertisedRef,
    PACKAGE_DIRECTORY: packageDirectory,
  };
  return {
    root,
    source,
    packageDirectory,
    incoming,
    host,
    target,
    advertisedRef,
    bundle,
    bundleHash,
    transferred,
    liveHelper,
    systemctlLog,
    env,
  };
}

test("commit-bound installation adds the locked helper without recreating OpenBot", () => {
  const input = hostFixture();
  try {
    const result = run(
      [
        "bash",
        wrapperPath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        input.target,
        input.transferred,
      ],
      input.root,
      input.env,
    );
    expect(result.exitCode).toBe(0);
    const match = result.stdout
      .toString()
      .match(/^OPENBOT_LOCK_EVIDENCE=(.+)$/m);
    expect(match).not.toBeNull();
    const evidence = match?.[1] ?? "";
    expect(statSync(evidence).mode & 0o777).toBe(0o600);
    expect(statSync(resolve(evidence, "..")).mode & 0o777).toBe(0o700);
    expect(readFileSync(evidence, "utf8")).toContain(
      `target_commit=${input.target}`,
    );
    expect(readFileSync(evidence, "utf8")).not.toMatch(
      /token|password|authorization|secret/i,
    );
    expect(readFileSync(input.liveHelper, "utf8")).toContain("--lock-held-fd");
    const activationManager = join(
      input.host,
      "usr/local/lib/netsfera/manage-openbot-g1-activation-v1.sh",
    );
    expect(existsSync(activationManager)).toBe(true);
    expect(statSync(activationManager).mode & 0o777).toBe(0o700);
    expect(
      existsSync(
        join(
          input.host,
          "etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf",
        ),
      ),
    ).toBe(true);
    const calls = readFileSync(input.systemctlLog, "utf8");
    expect(calls).toContain("daemon-reload");
    expect(calls).toContain("--property=ExecStart");
    expect(calls).toContain("--property=RefuseManualStop");
    expect(calls).not.toMatch(/restart|stop|start/);
    expect(calls).toContain(
      "docker ps --no-trunc --filter label=com.docker.compose.project=openbot --filter label=com.docker.compose.service=openbot --format {{.ID}}",
    );
    expect(existsSync(input.bundle)).toBe(false);
    expect(existsSync(input.transferred)).toBe(false);
    expect(
      readFileSync(
        join(
          input.host,
          "etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf",
        ),
        "utf8",
      ),
    ).toContain("RefuseManualStop=yes");
    const verifier = join(
      input.host,
      "usr/local/lib/netsfera/verify-openbot-lock-contract-v1.sh",
    );
    const verified = run(
      [verifier, "installed", input.target, evidence],
      input.root,
      input.env,
    );
    expect(verified.exitCode).toBe(0);

    const rollback = join(
      input.host,
      "usr/local/lib/netsfera/rollback-openbot-lock-contract-v1.sh",
    );
    const rolledBack = run([rollback, evidence], input.root, input.env);
    expect(rolledBack.exitCode).toBe(0);
    expect(readFileSync(input.liveHelper, "utf8")).toContain("old-helper");
    expect(existsSync(activationManager)).toBe(false);
    expect(existsSync(verifier)).toBe(false);
    expect(existsSync(evidence)).toBe(true);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each(["manifest", "legacy-marker"])(
  "host lock-contract rollback refuses active or partial G1 state: %s",
  (kind) => {
    const input = hostFixture();
    try {
      const installed = run(
        ["bash", installerPath, input.target, input.packageDirectory],
        input.root,
        input.env,
      );
      expect(installed.exitCode, installed.stderr.toString()).toBe(0);
      const evidence = installed.stdout
        .toString()
        .match(/^OPENBOT_LOCK_EVIDENCE=(.+)$/m)?.[1];
      expect(evidence).toBeDefined();
      const statePath = join(
        input.host,
        kind === "manifest"
          ? "etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest"
          : "etc/netsfera/bot-zero-trust/enable-openbot-g1",
      );
      mkdirSync(resolve(statePath, ".."), { recursive: true });
      writeFileSync(statePath, "active\n", { mode: 0o600 });
      const rollback = join(
        input.host,
        "usr/local/lib/netsfera/rollback-openbot-lock-contract-v1.sh",
      );
      const result = run([rollback, evidence ?? ""], input.root, input.env);
      expect(result.exitCode).toBe(65);
      expect(result.stderr.toString()).toContain("deactivate G1");
      expect(readFileSync(input.liveHelper, "utf8")).toContain(
        "--lock-held-fd",
      );
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test("lock conflict and installation failure both preserve G0", async () => {
  for (const mode of ["lock", "daemon-reload"] as const) {
    const input = hostFixture();
    try {
      let holder: ReturnType<typeof Bun.spawn> | undefined;
      if (mode === "lock") {
        holder = Bun.spawn(
          ["bash", "-c", 'exec 8>"$LOCK"; flock -n 8; printf ready; sleep 10'],
          {
            env: {
              ...process.env,
              LOCK: input.env.OPENBOT_DEPLOYMENT_LOCK_FILE,
            },
            stdout: "pipe",
          },
        );
        await Bun.sleep(100);
      }
      const result = run(
        ["bash", installerPath, input.target, input.packageDirectory],
        input.root,
        {
          ...input.env,
          FAIL_DAEMON_RELOAD: mode === "daemon-reload" ? "1" : "0",
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(input.liveHelper, "utf8")).toContain("old-helper");
      expect(
        existsSync(
          join(
            input.host,
            "etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf",
          ),
        ),
      ).toBe(false);
      if (mode === "lock") {
        expect(result.exitCode).toBe(75);
        expect(readFileSync(input.systemctlLog, "utf8")).toBe("");
      }
      holder?.kill();
      if (holder) await holder.exited;
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  }
});

test.each([
  ["SYSTEMD_EFFECTIVE_REFUSE", "no"],
  [
    "SYSTEMD_EFFECTIVE_EXECSTARTPRE",
    "{ path=/bin/false ; argv[]=/bin/false ; }",
  ],
  ["SYSTEMD_EFFECTIVE_EXECSTART", "{ path=/bin/false ; argv[]=/bin/false ; }"],
  ["SYSTEMD_EFFECTIVE_EXECSTOP", "{ path=/bin/false ; argv[]=/bin/false ; }"],
  [
    "SYSTEMD_EFFECTIVE_ENVIRONMENT",
    "OPENBOT_DEPLOYMENT_LOCK_FILE=/tmp/wrong.lock",
  ],
  ["SYSTEMD_EFFECTIVE_BINDSTO", "netsfera-docker-network-prepare.service"],
  ["SYSTEMD_EFFECTIVE_FRAGMENT", "/tmp/unreviewed.service"],
  ["SYSTEMD_EFFECTIVE_DROPINS", "/tmp/unreviewed.conf"],
])(
  "effective systemd override %s is rejected and restores G0",
  (key, value) => {
    const input = hostFixture();
    try {
      const result = run(
        ["bash", installerPath, input.target, input.packageDirectory],
        input.root,
        { ...input.env, [key]: value },
      );
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(input.liveHelper, "utf8")).toContain("old-helper");
      expect(
        existsSync(
          join(
            input.host,
            "etc/systemd/system/netsfera-openbot.service.d/20-deployment-lock-contract.conf",
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test("installer activates refusal and drains an in-flight restart before replacing the helper", () => {
  const input = hostFixture();
  try {
    const result = run(
      ["bash", installerPath, input.target, input.packageDirectory],
      input.root,
      {
        ...input.env,
        SYSTEMD_EFFECTIVE_JOB: "restart-job",
        OPENBOT_LOCK_DRAIN_ATTEMPTS: "1",
      },
    );
    expect(result.exitCode).not.toBe(0);
    const calls = readFileSync(input.systemctlLog, "utf8");
    expect(calls.indexOf("daemon-reload")).toBeLessThan(
      calls.indexOf("--property=Job"),
    );
    expect(calls.indexOf("--property=RefuseManualStop")).toBeLessThan(
      calls.indexOf("--property=Job"),
    );
    expect(readFileSync(input.liveHelper, "utf8")).toContain("old-helper");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("installer drains a restart already in flight in fail-closed order", () => {
  const input = hostFixture();
  const sequence = join(input.root, "job-sequence");
  writeFileSync(sequence, "0\n");
  try {
    const result = run(
      ["bash", installerPath, input.target, input.packageDirectory],
      input.root,
      { ...input.env, SYSTEMD_JOB_SEQUENCE_FILE: sequence },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const calls = readFileSync(input.systemctlLog, "utf8");
    const dropinInstall = calls.indexOf(
      "netsfera-openbot-deployment-lock.conf",
    );
    const reload = calls.indexOf("daemon-reload");
    const refusal = calls.indexOf("--property=RefuseManualStop");
    const job = calls.indexOf("--property=Job");
    const helperInstall = calls.indexOf("openbot-compose-lock-v1.sh");
    expect(dropinInstall).toBeGreaterThanOrEqual(0);
    expect(dropinInstall).toBeLessThan(reload);
    expect(reload).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(job);
    expect(job).toBeLessThan(helperInstall);
    expect(readFileSync(input.liveHelper, "utf8")).toContain("--lock-held-fd");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("runtime identity drift during bootstrap is critical and still restores host files", () => {
  const input = hostFixture();
  const drift = join(input.root, "runtime-drift");
  writeFileSync(drift, "0\n");
  try {
    const result = run(
      ["bash", installerPath, input.target, input.packageDirectory],
      input.root,
      { ...input.env, RUNTIME_DRIFT_FILE: drift },
    );
    expect(result.exitCode).toBe(70);
    expect(result.stderr.toString()).toContain("CRITICAL");
    expect(readFileSync(input.liveHelper, "utf8")).toContain("old-helper");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("the trusted wrapper rejects changed installer bytes before host mutation", () => {
  const input = hostFixture();
  try {
    writeFileSync(input.transferred, "#!/bin/sh\nprintf tampered\n", {
      mode: 0o700,
    });
    const result = run(
      [
        "bash",
        wrapperPath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        input.target,
        input.transferred,
      ],
      input.root,
      input.env,
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr.toString()).toContain("installer bytes do not match");
    expect(readFileSync(input.liveHelper, "utf8")).toContain("old-helper");
    expect(readFileSync(input.systemctlLog, "utf8")).toBe("");
    expect(existsSync(input.bundle)).toBe(false);
    expect(existsSync(input.transferred)).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("the trusted wrapper binds every installed artifact to the reviewed commit", () => {
  const contents = readFileSync(wrapperPath, "utf8");
  expect(contents).toContain("bundle verify");
  expect(contents).toContain("bundle list-heads");
  expect(contents).toContain("cat-file blob");
  expect(contents).toContain("install-openbot-lock-contract.sh");
  for (const name of [
    "openbot-compose-lock-v1.sh",
    "manage-openbot-g1-activation-v1.sh",
    "verify-openbot-lock-contract-v1.sh",
    "rollback-openbot-lock-contract-v1.sh",
    "netsfera-openbot-deployment-lock.conf",
  ]) {
    expect(contents).toContain(name);
  }
  expect(contents).not.toMatch(/git (checkout|switch)/);
});
