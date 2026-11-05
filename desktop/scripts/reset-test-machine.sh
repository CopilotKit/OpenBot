#!/bin/bash
# Reset OpenBot Desktop on this Mac to a never-installed state, CopilotKit CLI sign-in included, so
# the next launch goes through sign-in, the evaluation agreement and Install as a new person's would.
# See docs/installer-runbook.md.
#
# Leaves alone: Docker Desktop and Podman themselves, Intelligence stacks OpenBot did not create,
# your browsers' own data, and images (downloading them again is slow; pass --images to remove them).
#
#   desktop/scripts/reset-test-machine.sh [--dry-run] [--yes] [--remove-app] [--images]
set -uo pipefail

BUNDLE_ID=ai.copilotkit.openbot.desktop
ROOT="${OPENBOT_ROOT:-$HOME/OpenBot}"
APP=/Applications/OpenBot.app
CLI_CONFIG="$HOME/Library/Preferences/copilotkit-config-nodejs"
# Compose projects: earlier apps used the folder's name, current ones `openbot-desktop`.
PROJECTS=(openbot openbot-desktop)
MACHINE=openbot # the Podman machine OpenBot creates (acquire::MACHINE)
APP_PROCESS="OpenBot.app/Contents/MacOS/openbot-desktop"

dry=0 yes=0 remove_app=0 images=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --yes | -y) yes=1 ;;
    --remove-app) remove_app=1 ;;
    --images) images=1 ;;
    -h | --help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
run() { if ((dry)); then printf '    would run: %s\n' "$*"; else "$@"; fi; }
gone() { # remove the paths that exist
  local p
  for p in "$@"; do [[ -e "$p" || -L "$p" ]] && run rm -rf "$p"; done
  return 0
}

# The CLI the installed app runs, so logout and delete speak the same version as the app.
cli() {
  local b="$APP/Contents/Resources/cli-bundle"
  if [[ -x "$b/runtime/node" && -f "$b/cli/index.js" ]]; then
    "$b/runtime/node" "$b/cli/index.js" "$@"
  else
    npx --yes copilotkit "$@"
  fi
}

engines=()
command -v docker >/dev/null && docker info >/dev/null 2>&1 && engines+=(docker)
command -v podman >/dev/null && podman info >/dev/null 2>&1 && engines+=(podman)

stack=""
if [[ -f "$ROOT/.openbot-local-eval.json" ]]; then
  stack=$(jq -r 'select(.ownership == "created") | .stack // empty' "$ROOT/.openbot-local-eval.json" 2>/dev/null)
fi

say "Plan"
echo "    engines answering: ${engines[*]:-none}"
echo "    Intelligence stack OpenBot created: ${stack:-none recorded}"
((remove_app)) && echo "    also removing $APP"
((images)) && echo "    also removing OpenBot images"
if ((!dry && !yes)); then
  read -r -p "Reset OpenBot completely? [y/N] " answer
  [[ "$answer" == [yY]* ]] || {
    echo "Nothing changed."
    exit 1
  }
fi

say "Quitting OpenBot"
if pgrep -f "$APP_PROCESS" >/dev/null; then
  run osascript -e "quit app id \"$BUNDLE_ID\""
  for _ in $(seq 1 60); do
    ((dry)) && break
    pgrep -f "$APP_PROCESS" >/dev/null || break
    sleep 1
  done
  pgrep -f "$APP_PROCESS" >/dev/null && run pkill -f "$APP_PROCESS"
else
  echo "    not running"
fi

# A killed app can leave host-side processes behind in the installation folder.
say "Stopping processes left running in $ROOT"
while read -r pid cwd; do
  [[ "$cwd" == "$ROOT" || "$cwd" == "$ROOT"/* ]] && {
    echo "    pid $pid ($cwd)"
    run kill "$pid"
  }
done < <(lsof -a -d cwd -u "$(id -un)" -Fpn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^n/{print p, substr($0,2)}')

say "Deleting the Intelligence stack OpenBot created"
if [[ -z "$stack" ]]; then
  echo "    none recorded; other stacks are left alone"
elif ((dry)); then
  echo "    would run: copilotkit local delete --stack $stack --confirm-delete $stack --json"
else
  for attempt in 1 2 3 4; do
    out=$(cli local delete --stack "$stack" --confirm-delete "$stack" --json 2>&1) && {
      echo "    deleted $stack"
      break
    }
    if grep -q local_command_busy <<<"$out" && ((attempt < 4)); then
      echo "    CLI busy, retrying in 30s"
      sleep 30
      continue
    fi
    echo "    could not delete $stack:"
    tail -5 <<<"$out" | sed 's/^/      /'
    break
  done
fi

say "Signing the CopilotKit CLI out and clearing the evaluation agreement"
if ((dry)); then
  echo "    would run: copilotkit logout"
else
  cli logout >/dev/null 2>&1 && echo "    signed out" || echo "    was not signed in"
fi
# Only this file: the same folder keeps the records of your other stacks.
gone "$CLI_CONFIG/local/eula-acceptance.json"

for engine in "${engines[@]}"; do
  say "Removing OpenBot's containers, volumes and networks on $engine"
  ids="" vols="" nets=""
  for project in "${PROJECTS[@]}"; do
    ids+=$'\n'$("$engine" ps -aq --filter "label=com.docker.compose.project=$project")
    vols+=$'\n'$("$engine" volume ls -q --filter "label=com.docker.compose.project=$project")
    nets+=$'\n'$("$engine" network ls -q --filter "label=com.docker.compose.project=$project")
  done
  ids=$({
    echo "$ids"
    "$engine" ps -aq --filter "name=^openbot-"
  } | sed '/^$/d' | sort -u)
  vols=$({
    echo "$vols"
    "$engine" volume ls -q | grep -E '^openbot[_-]'
  } | sed '/^$/d' | sort -u)
  nets=$(echo "$nets" | sed '/^$/d' | sort -u)
  # shellcheck disable=SC2086 # one argument per id
  [[ -n "$ids" ]] && run "$engine" rm -f $ids
  # shellcheck disable=SC2086
  [[ -n "$vols" ]] && run "$engine" volume rm -f $vols
  # shellcheck disable=SC2086
  [[ -n "$nets" ]] && run "$engine" network rm $nets
  if ((images)); then
    imgs=$("$engine" images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)openbot(-[a-z0-9-]+)?:' | sort -u)
    # shellcheck disable=SC2086
    [[ -n "$imgs" ]] && run "$engine" rmi -f $imgs
  fi
  [[ -z "$ids$vols$nets" ]] && echo "    nothing there"
done

if command -v podman >/dev/null && podman machine inspect "$MACHINE" >/dev/null 2>&1; then
  say "Removing the Podman machine OpenBot created ($MACHINE)"
  run podman machine rm -f "$MACHINE"
fi

say "Removing OpenBot's files"
gone "$ROOT" \
  "$HOME/Library/Application Support/$BUNDLE_ID" \
  "$HOME/Library/Application Support/OpenBot" \
  "$HOME/Library/Caches/$BUNDLE_ID" "$HOME/Library/Caches/OpenBot" "$HOME/Library/Caches/openbot-desktop" \
  "$HOME/Library/WebKit/$BUNDLE_ID" "$HOME/Library/WebKit/openbot-desktop" \
  "$HOME/Library/HTTPStorages/$BUNDLE_ID" \
  "$HOME/Library/Preferences/$BUNDLE_ID.plist" \
  "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState"
shopt -s nullglob
gone "$HOME/Library/Application Support/"*/NativeMessagingHosts/ai.copilotkit.openbot*.json
shopt -u nullglob

if ((remove_app)); then
  say "Removing $APP"
  gone "$APP"
fi

say "Done. Open OpenBot from /Applications to start from the beginning."
