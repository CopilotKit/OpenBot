#!/usr/bin/env bash
# Compose boundary for the OpenBot host. Every public operation shares the
# deployment lock; controllers that already own it may pass its inherited FD.
set -euo pipefail
set +x

readonly deployment_lock_file="${OPENBOT_DEPLOYMENT_LOCK_FILE:-/var/lock/openbot-deployment.lock}"
readonly marker="${OPENBOT_PHASE2_MARKER:-/etc/netsfera/bot-zero-trust/enable-erp-phase2}"
readonly phase_environment="${OPENBOT_PHASE2_ENV_FILE:-/etc/netsfera/bot-zero-trust/erp-phase2.env}"
readonly attestation="${OPENBOT_PHASE2_ATTESTATION_FILE:-/etc/netsfera/bot-zero-trust/bot-erp-phase2.attested.env}"
readonly base_compose_file="${OPENBOT_BASE_COMPOSE_FILE:-docker-compose.yml}"
readonly supervisor_compose_file="${OPENBOT_SUPERVISOR_COMPOSE_FILE:-docker-compose.browser-supervisor.yml}"
readonly phase2_compose_file="${OPENBOT_PHASE2_COMPOSE_FILE:-docker-compose.erp-phase2.yml}"
readonly expected_lock_owner="${OPENBOT_EXPECTED_LOCK_OWNER:-0:0}"
readonly source_directory="${OPENBOT_SOURCE_DIR:-/opt/openbot/source}"
readonly incoming_directory="${OPENBOT_INCOMING_DIR:-/root/openbot-incoming}"
readonly g1_overlay_file="${OPENBOT_G1_OVERLAY_FILE:-${source_directory}/deploy/netsfera/docker-compose.erp-agent.yml}"
readonly activation_marker="${OPENBOT_G1_ACTIVATION_MARKER:-/etc/netsfera/bot-zero-trust/enable-openbot-g1}"
readonly activation_manifest="${OPENBOT_G1_ACTIVATION_MANIFEST:-/etc/netsfera/bot-zero-trust/openbot-g1-activation.manifest}"
readonly expected_activation_owner="${OPENBOT_EXPECTED_ACTIVATION_OWNER:-0:0}"

umask 077

inode_of() {
  if stat -Lc '%d:%i' "$1" >/dev/null 2>&1; then
    stat -Lc '%d:%i' "$1"
  else
    stat -f '%d:%i' "$1"
  fi
}

owner_mode() {
  if stat -c '%u:%g %a' "$1" >/dev/null 2>&1; then stat -c '%u:%g %a' "$1"; else stat -f '%u:%g %Lp' "$1"; fi
}

prepare_lock_file() {
  if [[ ! -e "$deployment_lock_file" && ! -L "$deployment_lock_file" ]]; then
    (set -o noclobber; : >"$deployment_lock_file") 2>/dev/null || true
  fi
  [[ -f "$deployment_lock_file" && ! -L "$deployment_lock_file" && \
    "$(owner_mode "$deployment_lock_file")" == "$expected_lock_owner 600" ]] || {
    printf '%s\n' 'OpenBot deployment lock file is unsafe' >&2
    exit 65
  }
}

prepare_lock_file

manifest_field() {
  awk -v key="$1" 'index($0,key "=")==1 { count++; value=substr($0,length(key)+2) } END { if(count!=1||value=="") exit 1; print value }' "$activation_manifest"
}

if [[ "${1:-}" == --lock-held-fd ]]; then
  [[ "$#" -ge 3 && "${2:-}" =~ ^[0-9]+$ ]] || {
    printf '%s\n' 'invalid inherited deployment lock FD' >&2
    exit 65
  }
  inherited_fd="$2"
  shift 2
  [[ -e "/proc/$$/fd/${inherited_fd}" ]] || {
    printf '%s\n' 'invalid inherited deployment lock FD' >&2
    exit 65
  }
  [[ "$(inode_of "/proc/$$/fd/${inherited_fd}")" == "$(inode_of "$deployment_lock_file")" ]] || {
    printf '%s\n' 'inherited deployment lock FD does not name the shared lock' >&2
    exit 65
  }
  if ! flock -n "$inherited_fd"; then
    printf '%s\n' 'inherited deployment lock FD is not held by this controller' >&2
    exit 75
  fi
else
  exec 9>"$deployment_lock_file"
  if ! flock -n 9; then
    printf '%s\n' 'OpenBot deployment lock is held by a concurrent operation' >&2
    exit 75
  fi
fi
[[ "$(inode_of "$deployment_lock_file")" == "$(inode_of "/proc/$$/fd/${inherited_fd:-9}")" ]] || {
  printf '%s\n' 'OpenBot deployment lock identity changed during acquisition' >&2
  exit 65
}

# Commit-reviewed controllers inherit the shared FD and supply a complete stack.
# An active binding permits diagnostic rendering only through this interface;
# all live mutations still use the public, manifest-bound command contract below.
controller_mode=0
if [[ "${1:-}" == --reviewed-controller ]]; then
  controller_mode=1
  [[ -n "${inherited_fd:-}" ]] || exit 64
  shift
  controller_arguments=("$@")
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p | --env-file | -f) [[ "$#" -ge 2 ]] || exit 64; shift 2 ;;
      *) break ;;
    esac
  done
  [[ "$#" -gt 0 ]] || exit 64
fi

base=(docker compose -f "$base_compose_file")
if [[ -e "$marker" || -L "$marker" ]]; then
  [[ -f "$marker" && ! -L "$marker" ]] || {
    printf '%s\n' 'invalid ERP phase-2 marker' >&2
    exit 1
  }
  [[ -f "$phase_environment" && ! -L "$phase_environment" && -r "$phase_environment" ]] || {
    printf '%s\n' 'missing readable ERP phase-2 environment' >&2
    exit 1
  }
  for required in "$phase_environment" "$attestation"; do
    [[ -f "$required" && ! -L "$required" && "$(stat -c '%u:%g:%a' "$required")" == '0:0:600' ]] || {
      printf '%s\n' 'invalid ERP phase-2 binding file' >&2
      exit 1
    }
  done
  cmp -s -- "$phase_environment" "$attestation" || {
    printf '%s\n' 'ERP phase-2 attestation mismatch' >&2
    exit 1
  }
  base=(docker compose --env-file .env --env-file "$phase_environment" \
    -f "$base_compose_file" -f "$supervisor_compose_file" -f "$phase2_compose_file")
fi

if [[ -e "$activation_marker" || -L "$activation_marker" ]]; then
  printf '%s\n' 'legacy or partial OpenBot G1 activation marker is forbidden' >&2
  exit 65
fi

if [[ "$controller_mode" -eq 1 ]]; then
  if [[ -e "$activation_manifest" || -L "$activation_manifest" ]]; then
    case "$*" in 'config --format json' | 'ps -q openbot') ;; *) exit 65 ;; esac
  fi
  exec docker compose "${controller_arguments[@]}"
fi

if [[ -e "$activation_manifest" || -L "$activation_manifest" ]]; then
  [[ -f "$activation_manifest" && ! -L "$activation_manifest" && \
    "$(owner_mode "$activation_manifest")" == "$expected_activation_owner 600" ]] || {
    printf '%s\n' 'invalid OpenBot G1 activation manifest' >&2
    exit 65
  }
  for selector_environment in COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES COMPOSE_PROJECT_NAME; do
    [[ -z "${!selector_environment:-}" ]] || {
      printf '%s\n' 'active G1 helper rejects Compose selector environment' >&2
      exit 64
    }
  done
  [[ "$#" -ge 1 ]] || exit 64
  case "$1" in
    config)
      [[ "$#" -eq 2 && "$2" == --quiet ]] || {
        printf '%s\n' 'active G1 helper accepts only the reviewed config preflight' >&2
        exit 64
      }
      ;;
    down)
      [[ "$#" -eq 1 ]] || {
        printf '%s\n' 'active G1 helper accepts only the reviewed down operation' >&2
        exit 64
      }
      ;;
    up)
      [[ "$#" -eq 3 && "$2" == --detach && "$3" == --remove-orphans ]] || {
        printf '%s\n' 'active G1 helper accepts only the reviewed exact apply operation' >&2
        exit 64
      }
      ;;
    exec | logs | ps | restart | run | stop) ;;
    *)
      printf '%s\n' 'active G1 helper rejects an unreviewed Compose subcommand' >&2
      exit 64
      ;;
  esac
  for caller_argument in "$@"; do
    case "$caller_argument" in
      -f | -f?* | --file | --file=* | --env-file | --env-file=* | \
        --project-directory | --project-directory=* | -p | -p?* | \
        --project-name | --project-name=* | --profile | --profile=*)
        printf '%s\n' 'active G1 helper rejects caller Compose selection overrides' >&2
        exit 64
        ;;
    esac
  done
  candidate_commit="$(manifest_field candidate_commit)"
  candidate_image_reference="$(manifest_field candidate_image_reference)"
  candidate_index_id="$(manifest_field candidate_index_id)"
  candidate_descriptor_digest="$(manifest_field candidate_descriptor_digest)"
  candidate_exact_reference="$(manifest_field candidate_exact_reference)"
  candidate_image_id="$(manifest_field candidate_image_id)"
  functional_overlay_path="$(manifest_field functional_overlay_path)"
  functional_overlay_sha256="$(manifest_field functional_overlay_sha256)"
  exact_overlay_path="$(manifest_field exact_overlay_path)"
  exact_overlay_sha256="$(manifest_field exact_overlay_sha256)"
  apply_render_sha256="$(manifest_field apply_render_sha256)"
  cmp -s "$activation_manifest" <(
    printf 'candidate_commit=%s\n' "$candidate_commit"
    printf 'candidate_image_reference=%s\n' "$candidate_image_reference"
    printf 'candidate_index_id=%s\n' "$candidate_index_id"
    printf 'candidate_descriptor_digest=%s\n' "$candidate_descriptor_digest"
    printf 'candidate_exact_reference=%s\n' "$candidate_exact_reference"
    printf 'candidate_image_id=%s\n' "$candidate_image_id"
    printf 'functional_overlay_path=%s\n' "$functional_overlay_path"
    printf 'functional_overlay_sha256=%s\n' "$functional_overlay_sha256"
    printf 'exact_overlay_path=%s\n' "$exact_overlay_path"
    printf 'exact_overlay_sha256=%s\n' "$exact_overlay_sha256"
    printf 'apply_render_sha256=%s\n' "$apply_render_sha256"
  ) || {
    printf '%s\n' 'OpenBot G1 activation manifest is not canonical' >&2
    exit 65
  }
  [[ "$candidate_commit" =~ ^[a-f0-9]{40}$ && "$candidate_image_id" =~ ^sha256:[a-f0-9]{64}$ && "$candidate_index_id" =~ ^sha256:[a-f0-9]{64}$ && "$candidate_descriptor_digest" =~ ^sha256:[a-f0-9]{64}$ && \
    "$functional_overlay_sha256" =~ ^[a-f0-9]{64}$ && "$exact_overlay_sha256" =~ ^[a-f0-9]{64}$ && \
    "$apply_render_sha256" =~ ^[a-f0-9]{64}$ && "$functional_overlay_path" == "$g1_overlay_file" ]] || exit 65
  [[ "$candidate_image_reference" =~ ^local/openbot:g1-${candidate_commit}-[a-f0-9]{16}$ ]] || exit 65
  [[ "$candidate_exact_reference" == "${candidate_image_reference}@${candidate_descriptor_digest}" ]] || exit 65
  case "$exact_overlay_path" in "${incoming_directory}"/g1-stage-"${candidate_commit}"-*.image.yml) ;; *) exit 65 ;; esac
  [[ -f "$functional_overlay_path" && ! -L "$functional_overlay_path" && \
    "$(sha256sum "$functional_overlay_path" | awk '{print $1}')" == "$functional_overlay_sha256" && \
    -f "$exact_overlay_path" && ! -L "$exact_overlay_path" && \
    "$(owner_mode "$exact_overlay_path")" == "$expected_activation_owner 600" && \
    "$(sha256sum "$exact_overlay_path" | awk '{print $1}')" == "$exact_overlay_sha256" ]] || exit 65
  [[ "$(git -C "$source_directory" rev-parse HEAD)" == "$candidate_commit" && -z "$(git -C "$source_directory" status --porcelain)" ]] || exit 65
  [[ "$(docker image inspect --format '{{.Id}}' "$candidate_image_reference")" == "$candidate_index_id" ]] || exit 65
  [[ "$(docker image inspect --format '{{index .Descriptor "digest"}}' "$candidate_image_reference")" == "$candidate_descriptor_digest" ]] || exit 65
  [[ "$(docker image inspect --format '{{.Id}}' "$candidate_exact_reference")" == "$candidate_index_id" ]] || exit 65
  activation_render=''
  render_child=''
  cleanup_render() {
    local private_render="$activation_render"
    activation_render=''
    [[ -z "$private_render" ]] || rm -f "$private_render"
  }
  on_render_exit() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ -n "$render_child" ]]; then
      kill -TERM "$render_child" 2>/dev/null || true
      wait "$render_child" 2>/dev/null || true
    fi
    if ! cleanup_render; then
      printf '%s\n' 'active helper render cleanup failed' >&2
      exit 71
    fi
    exit "$status"
  }
  trap on_render_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  activation_render="$(mktemp)"
  "${base[@]}" -f "$functional_overlay_path" -f "$exact_overlay_path" config --format json >"$activation_render" &
  render_child=$!
  wait "$render_child"
  render_child=''
  [[ "$(sha256sum "$activation_render" | awk '{print $1}')" == "$apply_render_sha256" ]] || exit 65
  jq -e --arg expected "$candidate_exact_reference" '.services.openbot.image == $expected' "$activation_render" >/dev/null || {
    exit 65
  }
  if ! cleanup_render; then
    printf '%s\n' 'active helper render cleanup failed' >&2
    exit 71
  fi
  trap - EXIT HUP INT TERM
  base+=( -f "$functional_overlay_path" -f "$exact_overlay_path" )
fi
exec "${base[@]}" "$@"
