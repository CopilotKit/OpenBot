<#
Fire-and-forget helper to send a Beacon progress event (Windows). Auto-fills the
repo and engineer, times out fast so it can never hang your work, and never
fails the caller. If BEACON_API_KEY isn't set it silently does nothing.

Usage (positional - the short form most callers reach for):
  powershell -File send-event.ps1 agent.heartbeat "Improving sign-in reliability"

Usage (flags):
  powershell -File send-event.ps1 -Type agent.planning -Task BCN-42 -Summary "..." -Confidence 0.9

The agent signature (which model, which harness) is detected automatically.
Override it with -Model/-Harness, or $env:BEACON_MODEL / $env:BEACON_HARNESS,
for a harness this doesn't recognise.

Usage (full JSON body):
  powershell -File send-event.ps1 -Json '{"type":"agent.heartbeat","summary":"..."}'

Config is resolved in this order, so the helper works standalone with no env:
  key: $env:BEACON_API_KEY, else ~/.beacon/key
  url: $env:BEACON_URL,     else ~/.beacon/url, else the public default
If ~/.beacon/disabled exists, the user opted out - do nothing, ever.

Never put secrets, tokens, or file contents in any field.
#>
# PositionalBinding=$false is load-bearing: by default PowerShell binds bare
# words to the named parameters in declaration order, so
# `send-event.ps1 agent.heartbeat "summary"` would put the summary in -Task and
# send a mislabelled event. Turning it off routes bare words to $Rest below,
# where they are interpreted the same way the bash helper interprets them.
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Type,
  [string]$Task,
  [string]$PlanTask,
  [string]$Summary,
  [string]$Reason,
  [string]$Confidence,
  [string]$Engineer,
  [string]$Repo,
  [string]$Model,
  [string]$Harness,
  [string]$Json,
  # Catches bare words so `send-event.ps1 agent.heartbeat "summary"` works the
  # same way it does in the bash helper. Without this, PowerShell would bind
  # them positionally to -Type/-Task and silently mislabel the event.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'SilentlyContinue'

# Bare words: the first is only taken as the type when it *looks* like one
# (dotted lowercase, e.g. agent.heartbeat), so a stray argument becomes a
# summary rather than a bogus event type. Leftovers are dropped, but never in
# silence - an argument quietly discarded here is an event nobody finds out
# was lost.
foreach ($arg in $Rest) {
  if (-not $arg) { continue }
  if ((-not $Type) -and ($arg -cmatch '^[a-z][a-z_]*\.[a-z][a-z_]*$')) { $Type = $arg }
  elseif (-not $Summary) { $Summary = $arg }
  else { [Console]::Error.WriteLine("send-event: ignoring unrecognized argument '$arg'") }
}

$beaconDir = Join-Path $HOME '.beacon'
if (Test-Path (Join-Path $beaconDir 'disabled')) { exit 0 }

$apiKey = $env:BEACON_API_KEY
if (-not $apiKey) {
  $keyFile = Join-Path $beaconDir 'key'
  if (Test-Path $keyFile) { $apiKey = (Get-Content $keyFile -Raw).Trim() }
}
if (-not $apiKey) { exit 0 }

$baseUrl = $env:BEACON_URL
if (-not $baseUrl) {
  $urlFile = Join-Path $beaconDir 'url'
  if (Test-Path $urlFile) { $baseUrl = (Get-Content $urlFile -Raw).Trim() }
}
if (-not $baseUrl) { $baseUrl = 'https://www.heybeacon.co' }
$baseUrl = $baseUrl.TrimEnd('/')

if (-not $Repo) {
  $url = (git remote get-url origin 2>$null)
  if ($url) {
    $url = $url -replace '\.git$', ''
    $Repo = (Split-Path (Split-Path $url -Parent) -Leaf) + '/' + (Split-Path $url -Leaf)
  }
  else {
    $top = (git rev-parse --show-toplevel 2>$null)
    if (-not $top) { $top = (Get-Location).Path }
    $Repo = Split-Path $top -Leaf
  }
}
if (-not $Engineer) {
  $Engineer = (git config user.name 2>$null)
  if (-not $Engineer) { $Engineer = (git config user.email 2>$null) }
}

# --- agent signature: which model did the work, inside which harness --------
# The same contract agent-signature.mjs implements for the hook path. Every
# step is allowed to find nothing: an absent field is honest, a guessed one
# becomes a category on the dashboard that nobody meant to create.
if (-not $Model) { $Model = $env:BEACON_MODEL }
if (-not $Harness) { $Harness = $env:BEACON_HARNESS }

if (-not $Harness) {
  # Best-effort environment fingerprints, most specific first. A harness that
  # isn't here resolves to nothing and the user sets BEACON_HARNESS - that
  # escape hatch is why the list can afford to be incomplete.
  $fingerprints = @(
    @('claude-code', @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT')),
    @('cursor', @('CURSOR_TRACE_ID', 'CURSOR_AGENT')),
    @('codex', @('CODEX_HOME', 'CODEX_SANDBOX')),
    @('gemini-cli', @('GEMINI_CLI', 'GEMINI_SANDBOX')),
    @('aider', @('AIDER_MODEL', 'AIDER_CHAT_HISTORY_FILE')),
    @('copilot', @('COPILOT_AGENT', 'GITHUB_COPILOT_CLI')),
    @('windsurf', @('WINDSURF_SESSION_ID', 'WINDSURF_USER')),
    @('cline', @('CLINE_SESSION_ID')),
    @('opencode', @('OPENCODE_SESSION_ID', 'OPENCODE_BIN')),
    @('amp', @('AMP_THREAD_ID')),
    @('replit', @('REPLIT_AGENT', 'REPL_ID')),
    @('devin', @('DEVIN_SESSION_ID'))
  )
  foreach ($fp in $fingerprints) {
    foreach ($name in $fp[1]) {
      if ([Environment]::GetEnvironmentVariable($name)) { $Harness = $fp[0]; break }
    }
    if ($Harness) { break }
  }
  if (-not $Harness -and $env:AI_AGENT) {
    # Generic descriptor, shaped `<name>_<dashed-version>_agent`. Take the name
    # when it matches that shape; otherwise the whole value, unparsed.
    if ($env:AI_AGENT -match '^([a-zA-Z0-9-]+)_[0-9-]+_agent$') { $Harness = $Matches[1] }
    else { $Harness = $env:AI_AGENT }
  }
}

# The transcript is the only place the model id appears - nothing exports it.
# Read a bounded tail (these files reach tens of megabytes) and take the most
# recent match, so a model switched mid-session is picked up rather than stale.
# Read for its own "model" field only; no message content is inspected. The
# "<" exclusion drops Claude Code's synthetic-turn placeholder, which is not a
# model anyone chose.
$SessionId = $env:CLAUDE_CODE_SESSION_ID
if ((-not $Model) -and $SessionId) {
  $transcript = Get-ChildItem (Join-Path $HOME ".claude\projects\*\$SessionId.jsonl") -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($transcript) {
    $hit = Get-Content $transcript.FullName -Tail 40 -ErrorAction SilentlyContinue |
      Select-String -Pattern '"model":"([^"<]+)"' -AllMatches |
      Select-Object -Last 1
    if ($hit) { $Model = $hit.Matches[$hit.Matches.Count - 1].Groups[1].Value }
  }
}

if ($Json) {
  $body = $Json
}
else {
  # Still exit 0 - telemetry never fails the caller - but say so, or a caller
  # with the wrong syntax gets a clean exit and an empty dashboard forever.
  if (-not $Type) {
    [Console]::Error.WriteLine('send-event: no event type given, nothing sent (try: send-event.ps1 agent.heartbeat "summary")')
    exit 0
  }
  $obj = @{ type = $Type; skillVersion = '2' }
  if ($Task) { $obj.task = $Task }
  if ($PlanTask) { $obj.planTaskId = $PlanTask }
  if ($Engineer) { $obj.engineer = $Engineer }
  if ($Summary) { $obj.summary = $Summary }
  if ($Reason) { $obj.reason = $Reason }
  if ($Repo) { $obj.repo = $Repo }
  if ($Model) { $obj.model = $Model }
  if ($Harness) { $obj.harness = $Harness }
  # Tags this as the model-authored path and joins it to the same session
  # timeline the hooks report on. Without these, agent.planning/completed
  # sit unattached beside the heartbeats they belong with.
  $obj.instrumentation = 'model'
  if ($SessionId) { $obj.sessionId = $SessionId }
  $c = 0.0
  if ($Confidence -and [double]::TryParse($Confidence, [ref]$c)) { $obj.confidence = $c }
  $body = $obj | ConvertTo-Json -Compress
}

# Report failures on stderr. A revoked key, a malformed payload, and a working
# send are otherwise indistinguishable - all exit 0 - which is how telemetry
# stays broken for weeks without anyone noticing.
try {
  Invoke-RestMethod -Method Post -Uri "$baseUrl/api/events" -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $apiKey" } `
    -ContentType 'application/json' -Body $body -ErrorAction Stop | Out-Null
}
catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 401 -or $status -eq 403) {
    [Console]::Error.WriteLine("send-event: Beacon rejected the API key (HTTP $status) - it may have been revoked")
  }
  elseif ($status) {
    [Console]::Error.WriteLine("send-event: Beacon rejected the event (HTTP $status)")
  }
  else {
    [Console]::Error.WriteLine("send-event: could not reach Beacon at $baseUrl (offline or timed out)")
  }
}
exit 0 # always, whatever happened above
