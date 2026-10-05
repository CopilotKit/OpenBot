# Refuse to run under a shell that is not bash, and say which one it is.
#
# Sourced as the first thing `start.sh` and `stop.sh` do, before either sets its options. Not
# executable and not a script anybody runs: it exits the shell that sourced it, which is the whole
# of what it is for.
#
# WHAT THIS IS ABOUT. `sh scripts/start.sh` overrides the `#!/usr/bin/env bash` line, and what it
# used to produce was exit 1 and not one character of output — no line number, no failing command,
# nothing to search for. On macOS `sh` IS bash, run in POSIX mode, where a failure these scripts
# survive under bash is fatal instead; the first setting read out of `.env` was enough to end the
# run. What somebody had to go on was the number 1, which reads as "this script is broken" rather
# than "run it the other way".
#
# EVERYTHING HERE IS POSIX SYNTAX ONLY, because the shell being warned about may not be bash at
# all. `set -o pipefail` is itself a bashism and a syntax error in dash, which is `sh` on most Linux
# distributions — so the refusal has to come before the `set` line in either caller, and without
# `local`, `[[` or `${!name}`. Anything bash-only written here would fail as a parse error in the
# one case it exists to explain.
#
# `SHELLOPTS` IS WHAT SEPARATES THE TWO BASHES. It is bash's own variable, absent in dash, and it
# lists `posix` exactly when bash was invoked as `sh`. A `BASH_VERSION` check alone cannot see that
# case, because bash-as-sh sets that too — which is the case on every Mac, so it is the case that
# actually happens.
openbot_wrong_shell=""
if [ -z "${BASH_VERSION:-}" ]; then
  openbot_wrong_shell="a shell that is not bash"
else
  case ":${SHELLOPTS:-}:" in
  *:posix:*) openbot_wrong_shell="bash in POSIX mode, which is what \`sh\` is" ;;
  esac
fi

if [ -n "$openbot_wrong_shell" ]; then
  # The fix and not only the fault. "Wrong shell" is not actionable to somebody who typed the only
  # invocation they knew, so the line that follows is the one to retype. On stderr, so a caller
  # reading the progress output still sees it.
  printf '\033[31m%s\033[0m\n' "This script is bash, and it is being read by $openbot_wrong_shell." >&2
  printf '%s\n' "Run it as: bash scripts/$(basename "$0")" >&2
  exit 1
fi

unset openbot_wrong_shell
