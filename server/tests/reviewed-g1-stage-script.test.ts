import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const stagePath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/stage-reviewed-g1.sh",
);
const wrapperPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/verify-reviewed-g1-stage-wrapper.sh",
);
const verifierPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/verify-staged-g1.sh",
);
const activationPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/manage-openbot-g1-activation-v1.sh",
);
const lockedHelperPath = resolve(
  import.meta.dir,
  "../../deploy/netsfera/openbot-compose-lock-v1.sh",
);
const target = "a".repeat(40);
const original = "ff5aa7ebd8ac798887017bfa1f5a471483b0c499";
const liveContainer = "1".repeat(64);
const oldImage = `sha256:${"2".repeat(64)}`;
const candidateImage = `sha256:${"3".repeat(64)}`;
const oldDescriptor = `sha256:${"4".repeat(64)}`;
const candidateDescriptor = `sha256:${"5".repeat(64)}`;
const oldIndex = `sha256:${"6".repeat(64)}`;
const candidateIndex = `sha256:${"7".repeat(64)}`;
const probeContainer = "8".repeat(64);
const bunImage =
  "oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";

function executable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openbot-g1-stage-"));
  const source = join(root, "source");
  const incoming = join(root, "incoming");
  const bin = join(root, "bin");
  const bundle = join(incoming, "reviewed.bundle");
  const sourceState = join(root, "source-state");
  const imageState = join(root, "image-state");
  const candidateTagState = join(root, "candidate-tag-state");
  const liveImageState = join(root, "live-image-state");
  const healthCount = join(root, "health-count");
  const probeImageState = join(root, "probe-image-state");
  const headCount = join(root, "head-count");
  const log = join(root, "commands.log");
  const lock = join(root, "openbot-deployment.lock");
  const activationMarker = join(root, "enable-openbot-g1");
  const activationManifest = join(root, "openbot-g1-activation.manifest");
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(join(source, "deploy/netsfera"), { recursive: true });
  mkdirSync(incoming);
  mkdirSync(bin);
  writeFileSync(bundle, "reviewed bundle bytes\n", { mode: 0o600 });
  writeFileSync(sourceState, `${original}\n`);
  writeFileSync(imageState, "old\n");
  writeFileSync(candidateTagState, "absent\n");
  writeFileSync(liveImageState, `${oldImage}\n`);
  writeFileSync(healthCount, "0\n");
  writeFileSync(probeImageState, "absent\n");
  writeFileSync(headCount, "0\n");
  writeFileSync(log, "");
  writeFileSync(lock, "", { mode: 0o600 });
  executable(
    join(source, "deploy/netsfera/verify-rendered-overlay.sh"),
    `#!/bin/sh
if [ "\${FAIL_MODE:-}" = render ]; then exit 28; fi
exit 0
`,
  );
  writeFileSync(
    join(source, "deploy/netsfera/docker-compose.erp-agent.yml"),
    "services:\n  openbot:\n    environment:\n      TENANT_PACKAGE: examples/netsfera\n",
  );
  executable(join(bin, "openbot-compose-v1.sh"), `#!/bin/sh
printf 'helper %s\\n' "$*" >>"$COMMAND_LOG"
exec "$LOCKED_HELPER" "$@"
`);
  executable(join(source, "deploy/netsfera/verify-netsfera-document-image.sh"),
    readFileSync(resolve(import.meta.dir, "../../deploy/netsfera/verify-netsfera-document-image.sh"), "utf8"));

  executable(
    join(bin, "git"),
    `#!/bin/sh
printf 'git %s\n' "$*" >>"$COMMAND_LOG"
case "$*" in
  *" bundle verify "*) exit 0;;
  *" bundle list-heads "*) printf '%s %s\n' "$TARGET_COMMIT" "$ADVERTISED_REF";;
  *" fetch --no-tags "*) exit 0;;
  *" rev-parse refs/heads/g1-reviewed-artifact") printf '%s\n' "$TARGET_COMMIT";;
  *" rev-parse $TARGET_COMMIT:deploy/netsfera/verify-staged-g1.sh") printf '%s\n' verifier-blob;;
  *" rev-parse HEAD")
    count=$(cat "$HEAD_COUNT"); count=$((count + 1)); printf '%s\n' "$count" >"$HEAD_COUNT"
    if [ "\${ROLLBACK_FAULT:-}" = rollback-source ] && [ "$count" -gt 1 ] && [ "$(cat "$SOURCE_STATE")" = "$ORIGINAL_COMMIT" ]; then
      printf '%s\n' "$TARGET_COMMIT"
    else
      cat "$SOURCE_STATE"
    fi;;
  *" cat-file -e "*) exit 0;;
  *" checkout --detach "*)
    for value do commit="$value"; done
    if [ "\${FAIL_MODE:-}" = checkout ] && [ "$commit" = "$TARGET_COMMIT" ]; then exit 21; fi
    printf '%s\n' "$commit" >"$SOURCE_STATE";;
  *" status --porcelain")
    current=$(cat "$SOURCE_STATE")
    if [ "\${FAIL_MODE:-}" = post-status ] && [ "$current" = "$TARGET_COMMIT" ]; then printf ' M changed\n'; fi
    if [ "\${ROLLBACK_FAULT:-}" = rollback-status ] && [ "$current" = "$ORIGINAL_COMMIT" ]; then exit 22; fi;;
  *" clone --quiet --no-hardlinks "*)
    for value do destination="$value"; done
    mkdir -p "$destination";;
  *" checkout --detach"*) exit 0;;
  *" cat-file blob verifier-blob") cat "$VERIFIER_SCRIPT_BYTES";;
  *" show $TARGET_COMMIT:deploy/netsfera/docker-compose.erp-agent.yml")
    if [ "\${FAIL_MODE:-}" = overlay-blob ]; then printf drift; else cat "$OPENBOT_SOURCE_DIR/deploy/netsfera/docker-compose.erp-agent.yml"; fi;;
  *" cat-file blob "*) cat "$REVIEWED_SCRIPT_BYTES";;
esac
`,
  );
  executable(
    join(bin, "jq"),
    `#!/bin/sh
set -eu
joined=" $* "
last=""
for value do last="$value"; done
case "$joined" in
  *' .services.openbot.image == $expected_image '*|*' .services.openbot.image == $expected '*)
    expected=""
    previous=""
    for value do
      if [ "$previous" = expected_image ] || [ "$previous" = expected ]; then expected="$value"; break; fi
      previous="$value"
    done
    grep -F -q '"image":"'"$expected"'"' "$last";;
  *' del(.services.openbot.image) '*)
    sed -E 's/"image":"[^"]*"/"image":"REMOVED"/' "$last";;
  *' .services.openbot.image '*)
    cat >/dev/null
    printf '%s\n' openbot:test;;
  *) exit 2;;
esac
`,
  );
  executable(
    join(bin, "df"),
    `#!/bin/sh
available=9999999
if [ "\${FAIL_MODE:-}" = space ]; then available=1; fi
printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
printf 'mock 10000000 1 %s 1%% /\n' "$available"
`,
  );
  executable(
    join(bin, "rm"),
    `#!/bin/sh
if [ "\${FAIL_CONSUMER_CLEANUP:-0}" = 1 ] && [ -f "$RENDER_RECORD" ] && [ "$*" = "-f $(cat "$RENDER_RECORD")" ]; then exit 55; fi
if [ "\${FAIL_ACTIVATION_ROLLBACK:-0}" = 1 ] && [ "$*" = "-f $OPENBOT_G1_ACTIVATION_MANIFEST" ]; then
  exit 56
fi
if [ "\${FAIL_MODE:-}" = cleanup ] && [ ! -e "$CLEANUP_MARKER" ]; then
  : >"$CLEANUP_MARKER"
  exit 55
fi
exec /bin/rm "$@"
`,
  );
  executable(join(bin, "mktemp"), `#!/bin/sh
created=$(/usr/bin/mktemp "$@") || exit $?
if [ -n "\${RENDER_RECORD:-}" ]; then
  case "$*" in ''|*g1-verify*) printf '%s\\n' "$created" >"$RENDER_RECORD";; esac
fi
printf '%s\\n' "$created"
`);
  executable(
    join(bin, "mv"),
    `#!/bin/sh
if [ "\${FAIL_ACTIVATION_MOVE:-0}" = 1 ] && printf '%s' "$*" | grep -q 'openbot-g1-activation.manifest'; then
  exit 57
fi
/bin/mv "$@" || exit $?
if [ "\${SIGNAL_AFTER_ACTIVATION_MOVE:-0}" = 1 ] && printf '%s' "$*" | grep -q 'openbot-g1-activation.manifest'; then
  kill -TERM "$PPID"
fi
`,
  );
  executable(
    join(bin, "docker"),
    `#!/bin/sh
set -eu
printf 'docker %s\n' "$*" >>"$COMMAND_LOG"
if [ "$1" = compose ]; then
  case " $* " in
    *" exec "*)
      if [ "\${FAIL_MODE:-}" = mcp-grant ] || [ "\${FAIL_MODE:-}" = bot-grant ]; then printf 'recolector-documentos\\t%s\\tforbidden\\n' "\${FAIL_MODE%-grant}"; fi
      exit 0;;
    *" up "*)
      if [ "\${ALLOW_LIVE_APPLY:-0}" != 1 ]; then printf 'forbidden live apply\n' >&2; exit 99; fi
      printf '%s' "$*" | grep -q 'docker-compose.erp-agent.yml' || exit 98
      printf '%s' "$*" | grep -q 'g1-stage-.*.image.yml' || exit 98
      printf '%s\n' "$CANDIDATE_IMAGE" >"$LIVE_IMAGE_STATE"
      exit 0;;
    *" create "*|*" run "*) printf 'forbidden live apply\n' >&2; exit 99;;
    *" config "*)
      if printf '%s' "$*" | grep -q 'g1-stage-.*.image.yml'; then
        case "\${CONSUMER_RENDER_MODE:-}" in
          failure) exit 42;;
          signal) kill -"\${CONSUMER_SIGNAL:-TERM}" "$CONSUMER_PID"; sleep 0.1;;
        esac
      fi
      image=openbot:test
      previous=""
      for value do
        if [ "$previous" = -f ] && [ -f "$value" ]; then
          selected=$(awk '$1 == "image:" { gsub(/"/, "", $2); print $2 }' "$value" | tail -1)
          if [ -n "$selected" ]; then image="$selected"; fi
        fi
        previous="$value"
      done
      if [ "\${FAIL_MODE:-}" = render-drift ] && printf '%s' "$*" | grep -q 'g1-stage-.*.image.yml'; then image="$OLD_IMAGE"; fi
      printf '{"services":{"openbot":{"image":"%s"}}}\n' "$image"
      exit 0;;
    *" build openbot "*)
      if [ "\${FAIL_MODE:-}" = build-with-activation ]; then
        printf 'stale\n' >"$OPENBOT_G1_ACTIVATION_MANIFEST"
        chmod 600 "$OPENBOT_G1_ACTIVATION_MANIFEST"
        exit 31
      fi
      if [ "\${FAIL_MODE:-}" = build ]; then exit 31; fi
      render=""
      previous=""
      for value do if [ "$previous" = -f ]; then render="$value"; fi; previous="$value"; done
      built_ref=$(awk -F '"image":"' '{ split($2, value, "\\\""); print value[1] }' "$render")
      case "$built_ref" in local/openbot:g1-*) printf '%s\n' "$built_ref" >"$CANDIDATE_TAG_STATE";; *) exit 97;; esac
      exit 0;;
    *" ps -q openbot "*) printf '%s\n' "$LIVE_CONTAINER"; exit 0;;
  esac
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  descriptor=0
  case " $* " in *'{{index .Descriptor "digest"}}'*) descriptor=1;; esac
  reference=""
  for value do reference="$value"; done
  case "$reference" in
    openbot:test)
      if [ "$(cat "$IMAGE_STATE")" = candidate ]; then
        if [ "$descriptor" = 1 ]; then printf '%s\n' "$CANDIDATE_DESCRIPTOR"; else printf '%s\n' "$CANDIDATE_INDEX"; fi
      else
        if [ "$descriptor" = 1 ]; then
          if [ "\${ROLLBACK_FAULT:-}" = rollback-descriptor ] && [ "$(cat "$HEAD_COUNT")" -gt 1 ]; then printf '%s\n' "$CANDIDATE_DESCRIPTOR"; else printf '%s\n' "$OLD_DESCRIPTOR"; fi
        else printf '%s\n' "$OLD_INDEX"; fi
      fi;;
    local/openbot:g1-*@$CANDIDATE_DESCRIPTOR)
      base="\${reference%@*}"
      if [ "$(cat "$CANDIDATE_TAG_STATE")" = "$base" ]; then
        if [ "$descriptor" = 1 ]; then printf '%s\n' "$CANDIDATE_DESCRIPTOR"; else printf '%s\n' "$CANDIDATE_INDEX"; fi
      else exit 1; fi;;
    local/openbot:g1-*)
      if [ "$(cat "$CANDIDATE_TAG_STATE")" = "$reference" ]; then
        if [ "$descriptor" = 1 ]; then printf '%s\n' "$CANDIDATE_DESCRIPTOR"; else printf '%s\n' "$CANDIDATE_INDEX"; fi
      else exit 1; fi;;
    "$CANDIDATE_IMAGE"|"$OLD_IMAGE") printf '%s\n' "$reference";;
    "$BUN_IMAGE") printf '%s\n' "$BUN_IMAGE_ID";;
    *) printf 'unknown image reference <%s>\n' "$reference" >&2; exit 1;;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = tag ]; then
  source="$3"
  if [ "\${OCI_INDEX_STORE:-0}" = 1 ] && { [ "$source" = "$OLD_IMAGE" ] || [ "$source" = "$CANDIDATE_IMAGE" ]; }; then
    printf 'Error response from daemon: No such image: %s\n' "$source" >&2
    exit 44
  fi
  if [ "\${ROLLBACK_FAULT:-}" = rollback-tag ]; then exit 41; fi
  destination=""
  for value do destination="$value"; done
  case "$destination" in
    openbot:test) printf 'old\n' >"$IMAGE_STATE";;
    local/openbot:g1-*) printf '%s\n' "$destination" >"$CANDIDATE_TAG_STATE";;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = rm ]; then
  printf 'absent\n' >"$CANDIDATE_TAG_STATE"
  exit 0
fi
if [ "$1" = create ]; then
  reference=""
  for value do reference="$value"; done
  case "$reference" in
    openbot:test|openbot:test@*) printf '%s\n' "$OLD_IMAGE" >"$PROBE_IMAGE_STATE";;
    local/openbot:g1-*) printf '%s\n' "$CANDIDATE_IMAGE" >"$PROBE_IMAGE_STATE";;
    *) exit 1;;
  esac
  printf '%s\n' "$PROBE_CONTAINER"
  exit 0
fi
if [ "$1" = rm ]; then
  if [ "\${PROBE_RM_FAIL:-0}" = 1 ] && [ "$(cat "$PROBE_IMAGE_STATE")" != absent ]; then exit 55; fi
  printf 'absent\n' >"$PROBE_IMAGE_STATE"
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$*" in
    *State.Health*)
      count=$(cat "$HEALTH_COUNT"); count=$((count + 1)); printf '%s\n' "$count" >"$HEALTH_COUNT"
      if [ "\${ROLLBACK_FAULT:-}" = rollback-health ] && [ "$count" -gt 1 ]; then printf 'unhealthy\n'; else printf 'healthy\n'; fi;;
    *"{{.Image}}"*)
      inspected=""; for value do inspected="$value"; done
      if [ "$inspected" = "$PROBE_CONTAINER" ]; then cat "$PROBE_IMAGE_STATE"
      elif [ "\${ROLLBACK_FAULT:-}" = rollback-live-image ] && [ "$(cat "$HEAD_COUNT")" -gt 1 ] && [ "$(cat "$SOURCE_STATE")" = "$ORIGINAL_COMMIT" ]; then printf '%s\n' "$CANDIDATE_IMAGE"
      else cat "$LIVE_IMAGE_STATE"; fi;;
  esac
  exit 0
fi
if [ "$1" = run ]; then
  case "$*" in
    *verify-netsfera-document-package.ts*)
      if [ "\${FAIL_MODE:-}" = package ]; then exit 34; fi
      printf '%s\\n' '{"jefe-erp":{"computerAccess":"disabled","skills":[]},"recolector-documentos":{"computerAccess":"enabled","skills":["crear-proveedor-documental","skill-creator"]}}'
      exit 0;;
    *oven/bun:1.3.14*|*"$BUN_IMAGE"*) if [ "\${FAIL_MODE:-}" = tests ]; then exit 32; fi;;
    *--entrypoint*) if [ "\${FAIL_MODE:-}" = brand ]; then exit 33; fi;;
  esac
  exit 0
fi
exit 0
`,
  );

  const advertisedRef = `refs/netsfera-review/${target}`;
  const bundleHash = new Bun.CryptoHasher("sha256")
    .update(readFileSync(bundle))
    .digest("hex");
  return {
    root,
    source,
    incoming,
    bin,
    bundle,
    bundleHash,
    advertisedRef,
    sourceState,
    imageState,
    candidateTagState,
    liveImageState,
    healthCount,
    probeImageState,
    headCount,
    log,
    lock,
    activationMarker,
    activationManifest,
    owner: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
  };
}

function environment(
  input: ReturnType<typeof fixture>,
  failMode?: string,
  rollbackFault?: string,
) {
  return {
    ...process.env,
    PATH: `${input.bin}:/usr/local/bin:/usr/bin:/bin`,
    OPENBOT_SOURCE_DIR: input.source,
    OPENBOT_INCOMING_DIR: input.incoming,
    OPENBOT_EXPECTED_BUNDLE_OWNER: input.owner,
    OPENBOT_EXPECTED_ACTIVATION_OWNER: input.owner,
    OPENBOT_BASE_ENV_FILE: "/unused/base.env",
    OPENBOT_PHASE2_ENV_FILE: "/unused/phase2.env",
    OPENBOT_BASE_COMPOSE_FILE: "/unused/base.yml",
    OPENBOT_SUPERVISOR_COMPOSE_FILE: "/unused/supervisor.yml",
    OPENBOT_PHASE2_COMPOSE_FILE: "/unused/phase2.yml",
    COMMAND_LOG: input.log,
    SOURCE_STATE: input.sourceState,
    IMAGE_STATE: input.imageState,
    CANDIDATE_TAG_STATE: input.candidateTagState,
    LIVE_IMAGE_STATE: input.liveImageState,
    HEALTH_COUNT: input.healthCount,
    HEAD_COUNT: input.headCount,
    CLEANUP_MARKER: join(input.root, "cleanup-marker"),
    TARGET_COMMIT: target,
    ORIGINAL_COMMIT: original,
    ADVERTISED_REF: input.advertisedRef,
    LIVE_CONTAINER: liveContainer,
    OLD_IMAGE: oldImage,
    CANDIDATE_IMAGE: candidateImage,
    OLD_DESCRIPTOR: oldDescriptor,
    CANDIDATE_DESCRIPTOR: candidateDescriptor,
    OLD_INDEX: oldIndex,
    CANDIDATE_INDEX: candidateIndex,
    PROBE_CONTAINER: probeContainer,
    PROBE_IMAGE_STATE: input.probeImageState,
    BUN_IMAGE: bunImage,
    BUN_IMAGE_ID: `sha256:${bunImage.split(":").at(-1)}`,
    OPENBOT_DEPLOYMENT_LOCK_FILE: input.lock,
    OPENBOT_G1_ACTIVATION_MARKER: input.activationMarker,
    OPENBOT_G1_ACTIVATION_MANIFEST: input.activationManifest,
    OPENBOT_STAGE_MIN_FREE_KB: "1024",
    REVIEWED_SCRIPT_BYTES: stagePath,
    VERIFIER_SCRIPT_BYTES: verifierPath,
    LOCKED_HELPER: lockedHelperPath,
    OPENBOT_COMPOSE_HELPER: join(input.bin, "openbot-compose-v1.sh"),
    ...(failMode ? { FAIL_MODE: failMode } : {}),
    ...(rollbackFault ? { ROLLBACK_FAULT: rollbackFault } : {}),
  };
}

function execute(
  input: ReturnType<typeof fixture>,
  failMode?: string,
  rollbackFault?: string,
) {
  return Bun.spawnSync(
    [
      "sh",
      stagePath,
      input.bundle,
      input.bundleHash,
      input.advertisedRef,
      target,
    ],
    { env: environment(input, failMode, rollbackFault) },
  );
}

function evidenceValue(evidence: string, key: string) {
  const line = evidence
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}=`));
  expect(line, `missing evidence field ${key}`).toBeDefined();
  return line?.slice(key.length + 1) ?? "";
}

function stagedEvidence(input: ReturnType<typeof fixture>) {
  const evidenceNames = readdirSync(input.incoming).filter((name) =>
    name.endsWith(".evidence"),
  );
  expect(evidenceNames).toHaveLength(1);
  const path = join(input.incoming, evidenceNames[0]);
  return { path, contents: readFileSync(path, "utf8") };
}

test.each(["mcp-grant", "bot-grant"])("staging refuses persisted %s before checkout or build", (mode) => {
  const input = fixture();
  try {
    const result = execute(input, mode);
    expect(result.exitCode).toBe(65);
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(readFileSync(input.log, "utf8")).not.toContain(" build openbot");
    expect(existsSync(input.activationManifest)).toBe(false);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("stages the reviewed candidate without applying it or changing the live container", () => {
  const input = fixture();
  try {
    const result = execute(input);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(target);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.healthCount, "utf8").trim()).toBe("2");
    const commands = readFileSync(input.log, "utf8");
    expect(commands).not.toMatch(/docker compose .*\b(up|create|run)\b/);
    expect(commands).toContain(`docker compose`);
    expect(commands).toContain("helper --lock-held-fd 9 --reviewed-controller");
    expect(commands.split("\n").filter((line) => line.startsWith("helper ")).length)
      .toBe(commands.split("\n").filter((line) => line.startsWith("docker compose ")).length);
    expect(commands).toContain("docker cp");
    expect(commands).toContain("verify-netsfera-document-package.ts");
    expect([...new Set(commands.match(/(?:server|app)\/tests\/[^\s]+\.test\.ts/g))].sort()).toEqual([
      "app/tests/computer-access.test.ts",
      "server/tests/app-build-tenant-config.test.ts",
      "server/tests/computer-access.test.ts",
      "server/tests/computer-policy.test.ts",
      "server/tests/computer-stream-access.test.ts",
      "server/tests/netsfera-document-agents.test.ts",
      "server/tests/netsfera-document-package-probe.test.ts",
    ]);
    expect(commands).toContain("kind <> 'skill'");
    expect(existsSync(input.activationManifest)).toBe(false);
    const { path: evidencePath, contents: evidence } = stagedEvidence(input);
    expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
    expect(evidence).toContain(`g0_source_commit=${original}`);
    expect(evidence).toContain(`accepted_g0_source_commit=${original}`);
    expect(evidence).toContain("g0_image_reference=openbot:test");
    expect(evidence).toContain(`g0_image_id=${oldImage}`);
    expect(evidence).toContain(`g0_index_id=${oldIndex}`);
    expect(evidence).toContain(`candidate_commit=${target}`);
    expect(evidence).toContain(`candidate_image_id=${candidateImage}`);
    expect(evidence).toContain(`candidate_index_id=${candidateIndex}`);
    const candidateReference = evidenceValue(
      evidence,
      "candidate_image_reference",
    );
    expect(candidateReference).toMatch(
      new RegExp(`^local/openbot:g1-${target}-[a-f0-9]{16}$`),
    );
    const candidateExactReference = `${candidateReference}@${candidateDescriptor}`;
    expect(evidence).toContain(
      `candidate_exact_reference=${candidateExactReference}`,
    );
    expect(evidence).toMatch(/candidate_overlay_sha256=[0-9a-f]{64}/);
    expect(evidence).toContain(
      `functional_overlay_path=${join(input.source, "deploy/netsfera/docker-compose.erp-agent.yml")}`,
    );
    expect(evidence).toMatch(/functional_overlay_sha256=[0-9a-f]{64}/);
    expect(evidence).toMatch(/candidate_apply_render_sha256=[0-9a-f]{64}/);
    const overlayPath = evidenceValue(evidence, "candidate_overlay_path");
    expect(overlayPath).toMatch(/g1-stage-.*\.image\.yml$/);
    expect(statSync(overlayPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(overlayPath, "utf8")).toBe(
      `services:\n  openbot:\n    image: "${candidateExactReference}"\n`,
    );
    expect(readFileSync(input.candidateTagState, "utf8").trim()).toBe(
      candidateReference,
    );
    expect(evidence).not.toMatch(/password|token|secret|authorization/i);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("stages safely when OCI descriptor and container config digests differ", () => {
  const input = fixture();
  try {
    const result = Bun.spawnSync(
      [
        "sh",
        stagePath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        target,
      ],
      { env: { ...environment(input), OCI_INDEX_STORE: "1" } },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const commands = readFileSync(input.log, "utf8");
    expect(commands).not.toContain(`docker image tag ${oldImage}`);
    expect(commands).not.toContain(`docker image tag ${candidateImage}`);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    const { contents: evidence } = stagedEvidence(input);
    expect(evidence).toContain(`g0_image_id=${oldImage}`);
    expect(evidence).toContain(`g0_descriptor_digest=${oldDescriptor}`);
    expect(evidence).toContain(`candidate_image_id=${candidateImage}`);
    expect(evidence).toContain(
      `candidate_descriptor_digest=${candidateDescriptor}`,
    );
    const candidateReference = evidenceValue(
      evidence,
      "candidate_image_reference",
    );
    expect(evidence).toContain(
      `candidate_exact_reference=${candidateReference}@${candidateDescriptor}`,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("staging reports cleanup failure when a stopped platform probe cannot be removed", () => {
  const input = fixture();
  try {
    const result = Bun.spawnSync(
      ["sh", stagePath, input.bundle, input.bundleHash, input.advertisedRef, target],
      { env: { ...environment(input), PROBE_RM_FAIL: "1" } },
    );
    expect(result.exitCode).toBe(71);
    expect(result.stdout.toString()).not.toContain("G1 staging complete");
    expect(readdirSync(input.incoming).filter((name) => name.endsWith(".evidence"))).toHaveLength(0);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("commit-bound verifier accepts pre-oneoff, pre-apply and exact healthy post-apply state", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    for (const phase of ["pre-oneoff", "pre-apply"]) {
      const verified = Bun.spawnSync(
        ["sh", verifierPath, phase, evidence.path],
        { env: environment(input) },
      );
      expect(verified.exitCode, verified.stderr.toString()).toBe(0);
    }
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    writeFileSync(input.liveImageState, `${candidateImage}\n`);
    const post = Bun.spawnSync(
      ["sh", verifierPath, "post-apply", evidence.path],
      { env: environment(input) },
    );
    expect(post.exitCode, post.stderr.toString()).toBe(0);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("post-apply verification refuses an MCP grant introduced after staging", () => {
  const input = fixture();
  try {
    expect(execute(input).exitCode).toBe(0);
    const evidence = stagedEvidence(input);
    expect(Bun.spawnSync(["bash", activationPath, "activate", evidence.path], { env: environment(input) }).exitCode).toBe(0);
    writeFileSync(input.liveImageState, `${candidateImage}\n`);
    const checked = Bun.spawnSync(["sh", verifierPath, "post-apply", evidence.path], { env: environment(input, "mcp-grant") });
    expect(checked.exitCode).toBe(65);
  } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("persistent G1 activation survives a systemd-style locked helper start and deactivates to G0", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    expect(statSync(input.activationManifest).mode & 0o777).toBe(0o600);
    expect(existsSync(input.activationMarker)).toBe(false);
    expect(readFileSync(input.activationManifest, "utf8")).toContain(
      `candidate_commit=${target}`,
    );
    expect(readFileSync(input.activationManifest, "utf8")).not.toMatch(
      /token|password|authorization|secret/i,
    );

    const verified = Bun.spawnSync(
      ["bash", activationPath, "verify", evidence.path],
      { env: environment(input) },
    );
    expect(verified.exitCode, verified.stderr.toString()).toBe(0);
    for (const operation of [["config", "--quiet"], ["down"]]) {
      const systemdStep = Bun.spawnSync(
        ["bash", lockedHelperPath, ...operation],
        { env: environment(input) },
      );
      expect(systemdStep.exitCode, systemdStep.stderr.toString()).toBe(0);
    }
    writeFileSync(input.log, "");
    const restarted = Bun.spawnSync(
      ["bash", lockedHelperPath, "up", "--detach", "--remove-orphans"],
      { env: { ...environment(input), ALLOW_LIVE_APPLY: "1" } },
    );
    expect(restarted.exitCode, restarted.stderr.toString()).toBe(0);
    const restartCommands = readFileSync(input.log, "utf8");
    expect(restartCommands).toContain(
      join(input.source, "deploy/netsfera/docker-compose.erp-agent.yml"),
    );
    expect(restartCommands).toContain(
      evidenceValue(evidence.contents, "candidate_overlay_path"),
    );
    expect(restartCommands).toMatch(/up --detach --remove-orphans/);
    const postRestart = Bun.spawnSync(
      ["sh", verifierPath, "post-apply", evidence.path],
      { env: environment(input) },
    );
    expect(postRestart.exitCode, postRestart.stderr.toString()).toBe(0);

    const deactivated = Bun.spawnSync(
      ["bash", activationPath, "deactivate", evidence.path],
      { env: environment(input) },
    );
    expect(deactivated.exitCode, deactivated.stderr.toString()).toBe(0);
    expect(existsSync(input.activationManifest)).toBe(false);
    expect(existsSync(input.activationMarker)).toBe(false);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each([
  "legacy-marker",
  "tampered-manifest",
  "tampered-marker",
  "tampered-overlay",
])("locked helper fails closed for active binding %s", (fault) => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    if (fault === "legacy-marker") {
      unlinkSync(input.activationManifest);
      writeFileSync(input.activationMarker, `candidate_commit=${target}\n`, {
        mode: 0o600,
      });
    }
    if (fault === "tampered-manifest") {
      writeFileSync(
        input.activationManifest,
        `${readFileSync(input.activationManifest)}candidate_commit=${"c".repeat(40)}\n`,
      );
    }
    if (fault === "tampered-marker") {
      writeFileSync(
        input.activationMarker,
        `candidate_commit=${"c".repeat(40)}\n`,
      );
    }
    if (fault === "tampered-overlay") {
      const overlay = evidenceValue(
        evidence.contents,
        "candidate_overlay_path",
      );
      writeFileSync(overlay, `${readFileSync(overlay)}# drift\n`);
    }
    writeFileSync(input.log, "");
    const result = Bun.spawnSync(
      ["bash", lockedHelperPath, "restart", "openbot"],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(input.log, "utf8")).not.toMatch(/restart openbot/);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each(["unknown-with-newline", "unknown-without-newline", "duplicate", "missing", "reordered", "blank-record", "no-final-newline"])(
  "locked helper rejects noncanonical manifest: %s", (fault) => {
    const input = fixture();
    try {
      expect(execute(input).exitCode).toBe(0);
      const evidence = stagedEvidence(input);
      expect(Bun.spawnSync(["bash", activationPath, "activate", evidence.path], { env: environment(input) }).exitCode).toBe(0);
      let contents = readFileSync(input.activationManifest, "utf8");
      if (fault === "unknown-with-newline") contents += "unknown=value\n";
      if (fault === "unknown-without-newline") contents += "unknown=value";
      if (fault === "duplicate") contents += `candidate_commit=${target}`;
      if (fault === "missing") contents = contents.split("\n").slice(1).join("\n");
      if (fault === "reordered") { const lines = contents.trimEnd().split("\n"); [lines[0], lines[1]] = [lines[1], lines[0]]; contents = lines.join("\n") + "\n"; }
      if (fault === "blank-record") contents += "\n";
      if (fault === "no-final-newline") contents = contents.trimEnd();
      writeFileSync(input.activationManifest, contents);
      writeFileSync(input.log, "");
      const checked = Bun.spawnSync(["bash", lockedHelperPath, "restart", "openbot"], { env: environment(input) });
      expect(checked.exitCode).not.toBe(0);
      expect(readFileSync(input.log, "utf8")).not.toMatch(/restart openbot/);
    } finally { rmSync(input.root, { recursive: true, force: true }); }
  },
);

test.each(["helper", "verifier"].flatMap((consumer) =>
  ["failure", "signal", "signal-hup", "signal-int", "cleanup", "failure-cleanup"].map((mode) => [consumer, mode] as const),
))("%s consumer preserves errors, cancellation and render cleanup: %s", (consumer, mode) => {
    const input = fixture();
    try {
      expect(execute(input).exitCode).toBe(0);
      const evidence = stagedEvidence(input);
      if (consumer === "helper") {
        expect(Bun.spawnSync(["bash", activationPath, "activate", evidence.path], { env: environment(input) }).exitCode).toBe(0);
      }
      const renderRecord = join(input.root, "render-record");
      const temporaryDirectory = join(input.root, "consumer-temporary");
      mkdirSync(temporaryDirectory);
      const command = consumer === "helper"
        ? ["bash", lockedHelperPath, "restart", "openbot"]
        : ["sh", verifierPath, "pre-apply", evidence.path];
      writeFileSync(input.log, "");
      const result = Bun.spawnSync(["bash", "-c", 'export CONSUMER_PID=$$; exec "$@"', "consumer", ...command], { env: {
        ...environment(input),
        TMPDIR: temporaryDirectory,
        RENDER_RECORD: renderRecord,
        CONSUMER_RENDER_MODE: mode.startsWith("failure") ? "failure" : mode.startsWith("signal") ? "signal" : "",
        CONSUMER_SIGNAL: mode === "signal-hup" ? "HUP" : mode === "signal-int" ? "INT" : "TERM",
        FAIL_CONSUMER_CLEANUP: mode.includes("cleanup") ? "1" : "0",
      } });
      expect(result.exitCode, `${consumer}/${mode}: ${result.stderr}`).toBe(mode.includes("cleanup") ? 71 : mode === "signal" ? 143 : mode === "signal-hup" ? 129 : mode === "signal-int" ? 130 : 42);
      const privateRender = readFileSync(renderRecord, "utf8").trim();
      expect(existsSync(privateRender)).toBe(mode.includes("cleanup"));
      if (mode.includes("cleanup")) expect(result.stderr.toString()).toContain("render cleanup failed");
      expect(result.stdout.toString()).not.toContain("verification passed");
      expect(readFileSync(input.log, "utf8")).not.toMatch(/docker compose .*restart openbot/);
    } finally { rmSync(input.root, { recursive: true, force: true }); }
});

test("deactivation cuts a tampered G1 binding and restores the evidenced G0 tag", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    writeFileSync(
      evidenceValue(evidence.contents, "candidate_overlay_path"),
      "tampered\n",
    );
    const deactivated = Bun.spawnSync(
      ["bash", activationPath, "deactivate", evidence.path],
      { env: environment(input) },
    );
    expect(deactivated.exitCode, deactivated.stderr.toString()).toBe(0);
    expect(existsSync(input.activationManifest)).toBe(false);
    expect(existsSync(input.activationMarker)).toBe(false);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("activation manager shares the deployment lock and does not mutate on conflict", async () => {
  const input = fixture();
  const ready = `${input.lock}.activation-ready`;
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    holder = Bun.spawn(
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
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
      await Bun.sleep(10);
    }
    const result = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(result.exitCode).toBe(75);
    expect(existsSync(input.activationMarker)).toBe(false);
    expect(existsSync(input.activationManifest)).toBe(false);
  } finally {
    holder?.kill();
    if (holder) await holder.exited;
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier shares the deployment lock with other deployment operations", async () => {
  const input = fixture();
  const ready = `${input.lock}.verifier-ready`;
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const holder = Bun.spawn(
      [
        "flock",
        "-n",
        input.lock,
        "bash",
        "-c",
        ': >"$READY"; while :; do sleep 1; done',
      ],
      { env: { ...process.env, READY: ready } },
    );
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) {
        await Bun.sleep(10);
      }
      const conflicted = Bun.spawnSync(
        ["sh", verifierPath, "pre-oneoff", evidence.path],
        { env: environment(input) },
      );
      expect(conflicted.exitCode).toBe(75);
      expect(conflicted.stderr.toString()).toContain("deployment lock is held");
    } finally {
      holder.kill();
      await holder.exited;
    }
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier refuses an independently opened FD while another process owns the lock", async () => {
  const input = fixture();
  const ready = `${input.lock}.attacker-ready`;
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    holder = Bun.spawn(
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
      const attacker = Bun.spawnSync(
        [
          "bash",
          "-c",
          'exec 9>"$OPENBOT_DEPLOYMENT_LOCK_FILE"; exec sh "$VERIFIER" --lock-held-fd 9 pre-oneoff "$EVIDENCE"',
        ],
        {
          env: {
            ...environment(input),
            VERIFIER: verifierPath,
            EVIDENCE: evidence.path,
          },
        },
      );
      expect(attacker.exitCode).not.toBe(0);
      expect(attacker.stderr.toString()).toContain(
        "inherited deployment lock FD is not held",
      );
      expect(existsSync(resolve(process.cwd(), "9"))).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
      holder = undefined;
    }
  } finally {
    holder?.kill();
    if (holder) await holder.exited;
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier acquires the passed open-file-description when no other process owns it", () => {
  const input = fixture();
  try {
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        'exec 9>"$OPENBOT_DEPLOYMENT_LOCK_FILE"; exec "$VERIFIER" --lock-held-fd 9 pre-oneoff "$MISSING_EVIDENCE"',
      ],
      {
        env: {
          ...environment(input),
          VERIFIER: verifierPath,
          MISSING_EVIDENCE: join(input.incoming, "g1-stage-missing.evidence"),
        },
      },
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr.toString()).toContain("evidence is missing");
    expect(result.stderr.toString()).not.toContain(
      "inherited deployment lock FD is not held",
    );
    expect(existsSync(resolve(process.cwd(), "9"))).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier rejects a unique candidate tag retargeted away from its exact ID", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    writeFileSync(input.candidateTagState, "local/openbot:g1-retargeted\n");
    const result = Bun.spawnSync(
      ["sh", verifierPath, "pre-oneoff", evidence.path],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "candidate tag no longer resolves",
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier rejects a changed exact-image overlay", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const overlayPath = evidenceValue(
      evidence.contents,
      "candidate_overlay_path",
    );
    writeFileSync(overlayPath, `${readFileSync(overlayPath)}# tampered\n`);
    const result = Bun.spawnSync(
      ["sh", verifierPath, "pre-apply", evidence.path],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "overlay is missing, unsafe or changed",
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier rejects source checkout drift from the evidenced candidate", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    writeFileSync(input.sourceState, `${original}\n`);
    const result = Bun.spawnSync(
      ["sh", verifierPath, "pre-apply", evidence.path],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("source checkout drifted");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("verifier rejects a full-stack render that drifted after staging", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const result = Bun.spawnSync(
      ["sh", verifierPath, "pre-apply", evidence.path],
      { env: environment(input, "render-drift") },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("full apply render drifted");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("post-apply verifier rejects a running image other than the staged exact ID", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    const result = Bun.spawnSync(
      ["sh", verifierPath, "post-apply", evidence.path],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "not the exact healthy staged image",
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each(["inactive", "tampered-activation"])(
  "post-apply verifier rejects %s persistent binding",
  (fault) => {
    const input = fixture();
    try {
      const staged = execute(input);
      expect(staged.exitCode, staged.stderr.toString()).toBe(0);
      const evidence = stagedEvidence(input);
      if (fault === "tampered-activation") {
        const activated = Bun.spawnSync(
          ["bash", activationPath, "activate", evidence.path],
          { env: environment(input) },
        );
        expect(activated.exitCode, activated.stderr.toString()).toBe(0);
        writeFileSync(
          input.activationManifest,
          `${readFileSync(input.activationManifest)}unknown=value\n`,
        );
      }
      writeFileSync(input.liveImageState, `${candidateImage}\n`);
      const result = Bun.spawnSync(
        ["sh", verifierPath, "post-apply", evidence.path],
        { env: environment(input) },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "persistent activation binding",
      );
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test.each(["move-failure", "signal-after-rename"])(
  "activation failure %s restores the single-file state to inactive",
  (fault) => {
    const input = fixture();
    try {
      const staged = execute(input);
      expect(staged.exitCode, staged.stderr.toString()).toBe(0);
      const evidence = stagedEvidence(input);
      const result = Bun.spawnSync(
        ["bash", activationPath, "activate", evidence.path],
        {
          env: {
            ...environment(input),
            FAIL_ACTIVATION_MOVE: fault === "move-failure" ? "1" : "0",
            SIGNAL_AFTER_ACTIVATION_MOVE:
              fault === "signal-after-rename" ? "1" : "0",
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(input.activationManifest)).toBe(false);
      expect(existsSync(input.activationMarker)).toBe(false);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test("activation rollback failure after a signal is critical", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const result = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      {
        env: {
          ...environment(input),
          SIGNAL_AFTER_ACTIVATION_MOVE: "1",
          FAIL_ACTIVATION_ROLLBACK: "1",
        },
      },
    );
    expect(result.exitCode).toBe(70);
    expect(result.stderr.toString()).toContain("CRITICAL");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("activation cleanup failure restores inactive state before exit 71", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const result = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input, "cleanup") },
    );
    expect(result.exitCode).toBe(71);
    expect(existsSync(input.activationManifest)).toBe(false);
    expect(existsSync(input.activationMarker)).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each([
  ["-f", "/tmp/evil.yml"],
  ["--file=/tmp/evil.yml"],
  ["--env-file", "/tmp/evil.env"],
  ["--project-directory=/tmp/evil"],
  ["-pevil"],
  ["--project-name", "evil"],
  ["--profile=evil"],
  ["--scale", "openbot=0"],
])("active helper rejects caller Compose selection override %j", (...args) => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    writeFileSync(input.log, "");
    const result = Bun.spawnSync(
      ["bash", lockedHelperPath, "up", "--detach", ...args],
      { env: { ...environment(input), ALLOW_LIVE_APPLY: "1" } },
    );
    expect(result.exitCode).toBe(64);
    const commands = readFileSync(input.log, "utf8");
    expect(commands).not.toMatch(/up --detach/);
    expect(commands).not.toContain("evil");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each([
  ["COMPOSE_FILE", "/tmp/evil.yml"],
  ["COMPOSE_ENV_FILES", "/tmp/evil.env"],
  ["COMPOSE_PROFILES", "evil"],
  ["COMPOSE_PROJECT_NAME", "evil"],
])("active helper rejects Compose selector environment %s", (name, value) => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    writeFileSync(input.log, "");
    const result = Bun.spawnSync(
      ["bash", lockedHelperPath, "up", "--detach", "--remove-orphans"],
      {
        env: {
          ...environment(input),
          ALLOW_LIVE_APPLY: "1",
          [name]: value,
        },
      },
    );
    expect(result.exitCode).toBe(64);
    expect(readFileSync(input.log, "utf8")).toBe("");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("post-apply verifier rejects an unhealthy exact candidate", () => {
  const input = fixture();
  try {
    const staged = execute(input);
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const evidence = stagedEvidence(input);
    const activated = Bun.spawnSync(
      ["bash", activationPath, "activate", evidence.path],
      { env: environment(input) },
    );
    expect(activated.exitCode, activated.stderr.toString()).toBe(0);
    writeFileSync(input.liveImageState, `${candidateImage}\n`);
    const result = Bun.spawnSync(
      ["sh", verifierPath, "post-apply", evidence.path],
      { env: environment(input, undefined, "rollback-health") },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "not the exact healthy staged image",
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("rejects a mismatched bundle SHA before changing source or image state", () => {
  const input = fixture();
  try {
    const result = Bun.spawnSync(
      [
        "sh",
        stagePath,
        input.bundle,
        "0".repeat(64),
        input.advertisedRef,
        target,
      ],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("bundle SHA-256 mismatch");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("rejects an arbitrary clean G0 checkout before staging mutation", () => {
  const input = fixture();
  try {
    const unexpected = "b".repeat(40);
    writeFileSync(input.sourceState, `${unexpected}\n`);
    const result = execute(input);
    expect(result.exitCode).toBe(65);
    expect(result.stderr.toString()).toContain("accepted G0 source commit");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(unexpected);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.log, "utf8")).not.toMatch(
      /build openbot|image tag/,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each(["manifest", "legacy-marker"])(
  "staging rejects stale G1 activation state %s before capture or build",
  (kind) => {
    const input = fixture();
    try {
      const stale =
        kind === "manifest" ? input.activationManifest : input.activationMarker;
      writeFileSync(stale, "stale\n", { mode: 0o600 });
      const result = execute(input);
      expect(result.exitCode).toBe(65);
      expect(result.stderr.toString()).toContain("activation state");
      expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
      expect(readFileSync(input.log, "utf8")).not.toMatch(
        /build openbot|image tag/,
      );
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test("rollback is critical if G1 activation state appears during staging", () => {
  const input = fixture();
  try {
    const result = execute(input, "build-with-activation");
    expect(result.exitCode).toBe(70);
    expect(result.stderr.toString()).toContain(
      "G1 activation state is not inactive",
    );
    expect(existsSync(input.activationManifest)).toBe(true);
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("rejects a bundle whose owner or mode is not approved", () => {
  const input = fixture();
  try {
    chmodSync(input.bundle, 0o644);
    const result = execute(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("bundle owner or mode");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("rejects a bundle whose advertised ref does not resolve to the requested commit", () => {
  const input = fixture();
  try {
    const result = Bun.spawnSync(
      [
        "sh",
        stagePath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        target,
      ],
      {
        env: {
          ...environment(input),
          ADVERTISED_REF: "refs/netsfera-review/wrong",
        },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "does not advertise the requested commit",
    );
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("rejects a noncanonical advertised ref even when it points at the requested commit", () => {
  const input = fixture();
  const wrongRef = "refs/heads/reviewed";
  try {
    const result = Bun.spawnSync(
      ["sh", stagePath, input.bundle, input.bundleHash, wrongRef, target],
      { env: { ...environment(input), ADVERTISED_REF: wrongRef } },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "advertised ref is not canonical",
    );
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each(["checkout", "tests", "render", "build", "brand", "post-status", "package", "overlay-blob"])(
  "restores exact G0 source and configured image after %s failure without applying Compose",
  (failure) => {
    const input = fixture();
    try {
      const result = execute(input, failure);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("staging failed");
      expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
      expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
      const commands = readFileSync(input.log, "utf8");
      expect(commands).toContain("git");
      expect(commands).not.toMatch(/docker compose .*\b(up|create|run)\b/);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test.each([
  "rollback-descriptor",
  "rollback-source",
  "rollback-status",
  "rollback-live-image",
  "rollback-health",
])(
  "reports CRITICAL exit 70 when %s prevents complete staging rollback",
  (failure) => {
    const input = fixture();
    try {
      const result = execute(input, "build", failure);
      expect(result.exitCode, result.stderr.toString()).toBe(70);
      expect(result.stderr.toString()).toContain("CRITICAL");
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);

test("cleanup failure restores G0 and removes staged evidence, overlay and tag", () => {
  const input = fixture();
  try {
    const result = execute(input, "cleanup");
    expect(result.exitCode, result.stderr.toString()).toBe(71);
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.candidateTagState, "utf8").trim()).toBe("absent");
    expect(
      readdirSync(input.incoming).filter(
        (name) => name.endsWith(".evidence") || name.endsWith(".image.yml"),
      ),
    ).toEqual([]);
    expect(existsSync(input.bundle)).toBe(true);
    expect(readFileSync(input.log, "utf8")).not.toMatch(
      /docker compose .*\b(up|create|run)\b/,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("uses only the pinned Bun digest for candidate tests", () => {
  const input = fixture();
  try {
    const result = execute(input);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const commands = readFileSync(input.log, "utf8");
    expect(commands).toContain(
      `docker image inspect --format {{.Id}} ${bunImage}`,
    );
    expect(commands).toContain(`docker run --rm`);
    expect(commands).toContain(bunImage);
    expect(commands).not.toContain("oven/bun:1.3.14");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("fails preflight before capture when a required dependency is missing", () => {
  const input = fixture();
  try {
    // Hide the system jq as well: this fixture must work on hosts with jq installed.
    const isolated = join(input.root, "isolated-bin");
    mkdirSync(isolated);
    for (const command of ["sh", "awk", "chmod", "cut", "date", "df", "docker", "flock", "git", "grep"]) {
      const actual = command === "docker" || command === "git" || command === "df"
        ? join(input.bin, command) : Bun.which(command)!;
      executable(join(isolated, command), `#!/bin/sh\nexec ${actual} "$@"\n`);
    }
    const result = Bun.spawnSync(["/bin/sh", stagePath, input.bundle, input.bundleHash, input.advertisedRef, target],
      { env: { ...environment(input), PATH: isolated } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing required command: jq");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.log, "utf8")).not.toContain("build openbot");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("fails preflight before capture when staging space is below the floor", () => {
  const input = fixture();
  try {
    const result = execute(input, "space");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("insufficient free space");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.log, "utf8")).not.toContain("build openbot");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("rejects a concurrent restart lock before mutating source or image state", async () => {
  const input = fixture();
  const ready = `${input.lock}.ready`;
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
    const result = execute(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("deployment lock is held");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(readFileSync(input.imageState, "utf8").trim()).toBe("old");
    expect(readFileSync(input.log, "utf8")).not.toMatch(
      /build openbot|image tag/,
    );
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("wrapper refuses transferred staging bytes that differ from the target commit", () => {
  const input = fixture();
  const transferred = join(input.incoming, "stage-reviewed-g1.sh");
  const marker = join(input.root, "executed");
  try {
    executable(transferred, `#!/bin/sh\nprintf executed >"${marker}"\n`);
    chmodSync(transferred, 0o700);
    const result = Bun.spawnSync(
      [
        "sh",
        wrapperPath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        target,
        transferred,
      ],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "staging script bytes do not match",
    );
    expect(() => readFileSync(marker)).toThrow();
    expect(existsSync(input.bundle)).toBe(false);
    expect(existsSync(transferred)).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("wrapper refuses correctly bound staging bytes with an unsafe mode", () => {
  const input = fixture();
  const transferred = join(input.incoming, "stage-reviewed-g1.sh");
  try {
    writeFileSync(transferred, readFileSync(stagePath));
    chmodSync(transferred, 0o755);
    const result = Bun.spawnSync(
      [
        "sh",
        wrapperPath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        target,
        transferred,
      ],
      { env: environment(input) },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("staging script owner or mode");
    expect(readFileSync(input.sourceState, "utf8").trim()).toBe(original);
    expect(existsSync(input.bundle)).toBe(false);
    expect(existsSync(transferred)).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("wrapper removes the reviewed bundle and transferred script after success", () => {
  const input = fixture();
  const transferred = join(input.incoming, "stage-reviewed-g1.sh");
  try {
    writeFileSync(transferred, readFileSync(stagePath));
    chmodSync(transferred, 0o700);
    const result = Bun.spawnSync(
      [
        "sh",
        wrapperPath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        target,
        transferred,
      ],
      { env: environment(input) },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(input.bundle)).toBe(false);
    expect(existsSync(transferred)).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test("wrapper removes the reviewed bundle and transferred script on signal", async () => {
  const input = fixture();
  const transferred = join(input.incoming, "stage-reviewed-g1.sh");
  const started = join(input.root, "wrapper-child-started");
  try {
    executable(
      transferred,
      `#!/bin/sh
: >"$WRAPPER_CHILD_STARTED"
trap 'exit 130' HUP INT TERM
while :; do sleep 1; done
`,
    );
    chmodSync(transferred, 0o700);
    const child = Bun.spawn(
      [
        "sh",
        wrapperPath,
        input.bundle,
        input.bundleHash,
        input.advertisedRef,
        target,
        transferred,
      ],
      {
        env: {
          ...environment(input),
          REVIEWED_SCRIPT_BYTES: transferred,
          WRAPPER_CHILD_STARTED: started,
        },
      },
    );
    for (let attempt = 0; attempt < 100 && !existsSync(started); attempt++) {
      await Bun.sleep(10);
    }
    expect(existsSync(started)).toBe(true);
    child.kill();
    await child.exited;
    expect(existsSync(input.bundle)).toBe(false);
    expect(existsSync(transferred)).toBe(false);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test.each([
  { childStatus: 0, expectedStatus: 71 },
  { childStatus: 70, expectedStatus: 70 },
])(
  "wrapper reports $expectedStatus when child exits $childStatus and cleanup fails",
  ({ childStatus, expectedStatus }) => {
    const input = fixture();
    const transferred = join(input.incoming, "stage-reviewed-g1.sh");
    try {
      executable(transferred, `#!/bin/sh\nexit ${childStatus}\n`);
      chmodSync(transferred, 0o700);
      const result = Bun.spawnSync(
        [
          "sh",
          wrapperPath,
          input.bundle,
          input.bundleHash,
          input.advertisedRef,
          target,
          transferred,
        ],
        {
          env: {
            ...environment(input, "cleanup"),
            REVIEWED_SCRIPT_BYTES: transferred,
          },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(expectedStatus);
      expect(existsSync(input.bundle)).toBe(true);
      expect(existsSync(transferred)).toBe(false);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  },
);
