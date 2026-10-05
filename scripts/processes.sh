# Find and stop this stack's own processes, for `start.sh` and `stop.sh`.
#
# Sourced by both, after `require-bash.sh`. Not executable and not a script anybody runs.
#
# Both scripts ask two questions. What is listening on a port: `lsof`. Is one of our background
# processes running: `pgrep -f`, and stop it with `pkill -f`. Git Bash on Windows has none of the
# three, and its `ps` cannot see a native process's arguments, so there every answer came back empty
# and every failure was silent. `stop.sh` said the app and server were "not running" and left them
# up. `start.sh` could not see a port held by something else. It also started another routine worker
# on every rerun, and then reported that the one it had just started "did not stay up".
#
# WHERE THE TOOL EXISTS, IT IS CALLED EXACTLY AS BEFORE. Only where it is missing on Windows does the
# question go to PowerShell, which ships with Windows. Its answers are Windows process ids, which Git
# Bash's `kill` does not accept, so stopping those goes through PowerShell as well.
#
# The port, pattern and ids reach PowerShell through the environment rather than on its command
# line, so a search for a pattern never finds the PowerShell process doing the searching, the way
# `pgrep -f` leaves itself out.

# `type -P` rather than `command -v`: only a program on PATH counts, not a shell function or alias of
# the same name that happens to be defined.
openbot_windows_without() {
  [ "${OS:-}" = "Windows_NT" ] && ! type -P "$1" >/dev/null 2>&1
}

# PowerShell writes CRLF. A trailing `\r` would make an empty answer non-empty and a pid unusable.
openbot_powershell() {
  powershell.exe -NoProfile -NonInteractive -Command "$1" 2>/dev/null | tr -d '\r' || true
}

# What is listening on a TCP port, as "name (address)", or nothing when the port is free.
holder() {
  if openbot_windows_without lsof; then
    OPENBOT_PORT="$1" openbot_powershell '
      Get-NetTCPConnection -State Listen -LocalPort $env:OPENBOT_PORT -ErrorAction SilentlyContinue |
        Select-Object -First 1 |
        ForEach-Object { "{0} ({1}:{2})" -f (Get-Process -Id $_.OwningProcess).ProcessName, $_.LocalAddress, $_.LocalPort }'
    return 0
  fi
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

# The ids of whatever is listening on a TCP port, one per line.
port_pids() {
  if openbot_windows_without lsof; then
    OPENBOT_PORT="$1" openbot_powershell '
      Get-NetTCPConnection -State Listen -LocalPort $env:OPENBOT_PORT -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique'
    return 0
  fi
  lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

# `kill [-9] <pids>`, for ids from `port_pids`. Windows has no SIGTERM to send a console process, so
# there both forms stop it outright. A stopped process takes a moment to go, so this waits for it,
# up to five seconds, rather than let the next check see it still there.
kill_pids() {
  if openbot_windows_without lsof; then
    OPENBOT_PIDS="$*" openbot_powershell '
      $ids = @($env:OPENBOT_PIDS -split " " | Where-Object { $_ -match "^[0-9]+$" })
      if ($ids) {
        Stop-Process -Force -Id $ids -ErrorAction SilentlyContinue
        Wait-Process -Id $ids -Timeout 5 -ErrorAction SilentlyContinue
      }' >/dev/null
    return 0
  fi
  kill "$@" 2>/dev/null || true
}

# The ids of processes whose command line is the pattern, such as `bun worker/src/index.ts`, and when
# asked, stopped and waited for as `kill_pids` does. Windows records the executable as a path,
# `C:\...\bun.exe` and sometimes quoted, so the first word is matched against the process name and
# the rest against its command line.
openbot_windows_matching() {
  OPENBOT_PATTERN="$1" OPENBOT_STOP="${2:-}" openbot_powershell '
    $name, $rest = $env:OPENBOT_PATTERN -split " ", 2
    $ids = @(Get-CimInstance Win32_Process |
      Where-Object { $_.Name -eq "$name.exe" -and $_.CommandLine -and $_.CommandLine.Contains(" $rest") } |
      ForEach-Object { $_.ProcessId })
    if ($ids -and $env:OPENBOT_STOP) {
      Stop-Process -Force -Id $ids -ErrorAction SilentlyContinue
      Wait-Process -Id $ids -Timeout 5 -ErrorAction SilentlyContinue
    }
    $ids'
}

# `pgrep -f <pattern>`: true when such a process is running.
running() {
  if openbot_windows_without pgrep; then
    [ -n "$(openbot_windows_matching "$1")" ]
    return
  fi
  pgrep -f "$1" >/dev/null 2>&1
}

# `pkill -f <pattern>`.
stop_matching() {
  if openbot_windows_without pkill; then
    openbot_windows_matching "$1" stop >/dev/null
    return 0
  fi
  pkill -f "$1" >/dev/null 2>&1 || true
}
