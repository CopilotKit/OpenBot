import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const recoveryPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/recover-openbot-g0-baseline-v1.sh",
);
const wrapperPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/verify-reviewed-g0-recovery-wrapper.sh",
);

test("G0 recovery artifacts are present and commit-bound", () => {
  expect(existsSync(recoveryPath)).toBe(true);
  expect(existsSync(wrapperPath)).toBe(true);
});

test("recovery wrapper terminates its child before deleting transferred artifacts", () => {
  const wrapper = readFileSync(wrapperPath, "utf8");
  expect(wrapper).toContain("child_pid=$!");
  expect(wrapper).toContain('kill -TERM "$child_pid"');
  expect(wrapper).toContain('wait "$child_pid"');
  expect(wrapper.indexOf('kill -TERM "$child_pid"')).toBeLessThan(
    wrapper.indexOf('rm -f "$bundle_path" "$script_path"'),
  );
});

test("G0 recovery uses addressable OCI descriptors and never tags a config digest", () => {
  const script = readFileSync(recoveryPath, "utf8");
  expect(script).toContain(`{{index .Descriptor "digest"}}`);
  expect(script).toContain('recovery_exact_reference="${recovery_reference}@${recovery_descriptor_digest}"');
  expect(script).toContain('docker image tag "$recovery_exact_reference" "$g0_image_reference"');
  expect(script).not.toMatch(/docker image tag \"\$(?:live|g0|recovery)_image_id\"/);
});

test("G0 recovery builds under an isolated ref and recreates only OpenBot", () => {
  const script = readFileSync(recoveryPath, "utf8");
  expect(script).toMatch(/local\/openbot:g0-recovery-/);
  expect(script).toContain('-f "$recovery_build_render" build openbot');
  expect(script).toContain("--no-deps --force-recreate openbot");
  expect(script).not.toMatch(/\b(up|create|restart)\b.*(?:browser|supervisor|worker)/);
});

test("G0 recovery requires exact ff5 source, inactive G1 and bounded health", () => {
  const script = readFileSync(recoveryPath, "utf8");
  expect(script).toContain("ff5aa7ebd8ac798887017bfa1f5a471483b0c499");
  expect(script).toContain("activation_state_absent");
  expect(script).toContain("OPENBOT_RECOVERY_HEALTH_TIMEOUT_SECONDS");
  expect(script).toContain("deadline");
});

test("G0 recovery evidence records config and descriptor identities without secrets", () => {
  const script = readFileSync(recoveryPath, "utf8");
  for (const field of [
    "previous_base_image_id",
    "previous_base_descriptor_digest",
    "recovered_g0_image_id",
    "recovered_g0_descriptor_digest",
    "recovered_g0_exact_reference",
    "new_live_container_id",
  ]) {
    expect(script).toContain(`printf '${field}=%s\\n'`);
  }
  expect(script).not.toMatch(/printf[^\n]*(token|secret|password|authorization)/i);
});

const accepted = "ff5aa7ebd8ac798887017bfa1f5a471483b0c499";
const oldContainer = "1".repeat(64);
const newContainer = "2".repeat(64);
const probeContainer = "3".repeat(64);
const oldConfig = `sha256:${"4".repeat(64)}`;
const corruptIndex = `sha256:${"5".repeat(64)}`;
const corruptDescriptor = `sha256:${"6".repeat(64)}`;
const recoveredIndex = `sha256:${"7".repeat(64)}`;
const recoveredDescriptor = `sha256:${"8".repeat(64)}`;
const recoveredConfig = `sha256:${"9".repeat(64)}`;

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function recoveryFixture() {
  const root = mkdtempSync(`${tmpdir()}/openbot-g0-recovery-`);
  const source = `${root}/source`;
  const incoming = `${root}/incoming`;
  const bin = `${root}/bin`;
  const lock = `${root}/lock`;
  const baseState = `${root}/base-state`;
  const liveState = `${root}/live-state`;
  const probeState = `${root}/probe-state`;
  const commands = `${root}/commands`;
  mkdirSync(`${source}/.git`, { recursive: true });
  mkdirSync(`${source}/deploy/netsfera`, { recursive: true });
  mkdirSync(incoming);
  mkdirSync(bin);
  writeFileSync(lock, "", { mode: 0o600 });
  writeFileSync(baseState, "corrupt\n");
  writeFileSync(liveState, "old\n");
  writeFileSync(probeState, "absent\n");
  writeFileSync(commands, "");
  writeFileSync(
    `${source}/deploy/netsfera/docker-compose.erp-agent.yml`,
    "services:\n  openbot:\n    environment:\n      TENANT_PACKAGE: examples/netsfera\n",
  );
  executable(
    `${source}/deploy/netsfera/verify-rendered-overlay.sh`,
    "#!/bin/sh\n[ \"${FAIL_MODE:-}\" != render ]\n",
  );
  executable(
    `${bin}/git`,
    `#!/bin/sh
case "$*" in
  *" rev-parse HEAD") printf '%s\n' "$ACCEPTED";;
  *" status --porcelain") :;;
  *" clone --quiet --no-hardlinks "*) for value do destination="$value"; done; mkdir -p "$destination";;
  *" checkout --detach "*) :;;
esac
`,
  );
  executable(
    `${bin}/jq`,
    `#!/bin/sh
case " $* " in
  *" .services.openbot.image ") cat >/dev/null; printf '%s\n' openbot:test;;
  *" del(.services.openbot.image) ") cat "$2" 2>/dev/null || cat;;
  *" .services.openbot.image == "*) exit 0;;
  *) exit 0;;
esac
`,
  );
  executable(
    `${bin}/docker`,
    `#!/bin/sh
set -eu
printf 'docker %s\n' "$*" >>"$COMMANDS"
if [ "$1" = compose ]; then
  case " $* " in
    *" config "*)
      image=openbot:test
      for value do
        if [ -f "$value" ]; then selected=$(awk '$1 == "image:" {gsub(/"/,"",$2); print $2}' "$value" | tail -1); [ -z "$selected" ] || image="$selected"; fi
      done
      printf '{"services":{"openbot":{"image":"%s"}}}\n' "$image";;
    *" ps -q openbot "*) if [ "$(cat "$LIVE_STATE")" = old ]; then printf '%s\n' "$OLD_CONTAINER"; else printf '%s\n' "$NEW_CONTAINER"; fi;;
    *" build openbot "*) [ "\${FAIL_MODE:-}" != build ];;
    *" up --detach --no-deps --force-recreate openbot "*) printf 'new\n' >"$LIVE_STATE";;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  descriptor=0; case " $* " in *'{{index .Descriptor "digest"}}'*) descriptor=1;; esac
  reference=""; for value do reference="$value"; done
  case "$reference" in
    openbot:test)
      if [ "$(cat "$BASE_STATE")" = corrupt ]; then [ "$descriptor" = 1 ] && printf '%s\n' "$CORRUPT_DESCRIPTOR" || printf '%s\n' "$CORRUPT_INDEX"
      else
        if [ "\${FAIL_MODE:-}" = post-tag ] && [ "$descriptor" = 1 ]; then printf '%s\n' "$CORRUPT_DESCRIPTOR"; else [ "$descriptor" = 1 ] && printf '%s\n' "$RECOVERED_DESCRIPTOR" || printf '%s\n' "$RECOVERED_INDEX"; fi
      fi;;
    local/openbot:g0-recovery-*) [ "$descriptor" = 1 ] && printf '%s\n' "$RECOVERED_DESCRIPTOR" || printf '%s\n' "$RECOVERED_INDEX";;
    openbot:test@"$CORRUPT_DESCRIPTOR") [ "$descriptor" = 1 ] && printf '%s\n' "$CORRUPT_DESCRIPTOR" || printf '%s\n' "$CORRUPT_INDEX";;
    *) exit 1;;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = tag ]; then
  source="$3"; destination="$4"
  case "$source" in openbot:test@"$CORRUPT_DESCRIPTOR") printf 'corrupt\n' >"$BASE_STATE";; local/openbot:g0-recovery-*@*) printf 'recovered\n' >"$BASE_STATE";; *) exit 44;; esac
  [ "$destination" = openbot:test ]
  exit 0
fi
if [ "$1" = image ] && [ "$2" = rm ]; then exit 0; fi
if [ "$1" = create ]; then printf '%s\n' "$RECOVERED_CONFIG" >"$PROBE_STATE"; printf '%s\n' "$PROBE_CONTAINER"; exit 0; fi
if [ "$1" = rm ]; then printf 'absent\n' >"$PROBE_STATE"; exit 0; fi
if [ "$1" = inspect ]; then
  inspected=""; for value do inspected="$value"; done
  case " $* " in
    *State.Health*) printf 'healthy\n';;
    *"{{.Image}}"*)
      if [ "$inspected" = "$PROBE_CONTAINER" ]; then printf '%s\n' "$RECOVERED_CONFIG"
      elif [ "$(cat "$LIVE_STATE")" = old ]; then printf '%s\n' "$OLD_CONFIG"
      else printf '%s\n' "$RECOVERED_CONFIG"; fi;;
  esac
  exit 0
fi
if [ "$1" = run ]; then [ "\${FAIL_MODE:-}" != brand ]; exit; fi
exit 0
`,
  );
  return { root, source, incoming, bin, lock, baseState, liveState, probeState, commands };
}

function runRecovery(input: ReturnType<typeof recoveryFixture>, failMode?: string) {
  return Bun.spawnSync(["bash", recoveryPath, oldContainer, oldConfig], {
    env: {
      ...process.env,
      PATH: `${input.bin}:/usr/local/bin:/usr/bin:/bin`,
      OPENBOT_COMPOSE_HELPER: resolve(import.meta.dir, "../../deploy/netsfera/openbot-compose-lock-v1.sh"),
      OPENBOT_SOURCE_DIR: input.source,
      OPENBOT_INCOMING_DIR: input.incoming,
      OPENBOT_DEPLOYMENT_LOCK_FILE: input.lock,
      OPENBOT_BASE_ENV_FILE: "/unused/base.env",
      OPENBOT_PHASE2_ENV_FILE: "/unused/phase2.env",
      OPENBOT_BASE_COMPOSE_FILE: "/unused/base.yml",
      OPENBOT_SUPERVISOR_COMPOSE_FILE: "/unused/supervisor.yml",
      OPENBOT_PHASE2_COMPOSE_FILE: "/unused/phase2.yml",
      OPENBOT_RECOVERY_HEALTH_TIMEOUT_SECONDS: "2",
      ACCEPTED: accepted,
      COMMANDS: input.commands,
      BASE_STATE: input.baseState,
      LIVE_STATE: input.liveState,
      PROBE_STATE: input.probeState,
      OLD_CONTAINER: oldContainer,
      NEW_CONTAINER: newContainer,
      PROBE_CONTAINER: probeContainer,
      OLD_CONFIG: oldConfig,
      CORRUPT_INDEX: corruptIndex,
      CORRUPT_DESCRIPTOR: corruptDescriptor,
      RECOVERED_INDEX: recoveredIndex,
      RECOVERED_DESCRIPTOR: recoveredDescriptor,
      RECOVERED_CONFIG: recoveredConfig,
      ...(failMode ? { FAIL_MODE: failMode } : {}),
    },
  });
}

test("executable recovery establishes a distinct reviewed config/index/descriptor baseline", () => {
  const input = recoveryFixture();
  try {
    const result = runRecovery(input);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(input.baseState, "utf8").trim()).toBe("recovered");
    expect(readFileSync(input.liveState, "utf8").trim()).toBe("new");
    expect(readFileSync(input.probeState, "utf8").trim()).toBe("absent");
    const log = readFileSync(input.commands, "utf8");
    expect(log).toContain(`image tag local/openbot:g0-recovery-`);
    expect(log).toContain("up --detach --no-deps --force-recreate openbot");
    expect(log).not.toContain(`image tag ${oldConfig}`);
    const evidence = readdirSync(input.incoming).find((name) => name.endsWith(".evidence"));
    expect(evidence).toBeDefined();
    expect(statSync(`${input.incoming}/${evidence}`).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("recovery failure before retag leaves base and live unchanged and removes the probe", () => {
  const input = recoveryFixture();
  try {
    const result = runRecovery(input, "brand");
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(input.baseState, "utf8").trim()).toBe("corrupt");
    expect(readFileSync(input.liveState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.probeState, "utf8").trim()).toBe("absent");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("post-retag identity failure restores the exact previous descriptor before apply", () => {
  const input = recoveryFixture();
  try {
    const result = runRecovery(input, "post-tag");
    expect(result.exitCode).toBe(70);
    expect(readFileSync(input.baseState, "utf8").trim()).toBe("corrupt");
    expect(readFileSync(input.liveState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.probeState, "utf8").trim()).toBe("absent");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});
