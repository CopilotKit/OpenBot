<#
.SYNOPSIS
  Reset OpenBot Desktop on this PC to a never-installed state, CopilotKit CLI sign-in included, so the
  next launch goes through sign-in, the evaluation agreement and Install as a new person's would.
  See docs/installer-runbook.md.

.DESCRIPTION
  Leaves alone: Docker Desktop, Podman and WSL themselves, Intelligence stacks OpenBot did not
  create, your browsers' own data, and images (pass -Images to remove them).

.EXAMPLE
  .\reset-test-machine.ps1 -DryRun
  .\reset-test-machine.ps1
  .\reset-test-machine.ps1 -RemoveApp -Yes
#>
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$RemoveApp,
  [switch]$Images,
  [string]$StackId        # an Intelligence stack OpenBot made, when ~\OpenBot (which records it) is already gone
)
$ErrorActionPreference = 'Continue'

$BundleId = 'ai.copilotkit.openbot.desktop'
$Root = if ($env:OPENBOT_ROOT) { $env:OPENBOT_ROOT } else { Join-Path $HOME 'OpenBot' }
$AppDir = Join-Path $env:LOCALAPPDATA 'OpenBot'        # the per-user NSIS install, beside the Recorder's files
$Projects = @('openbot', 'openbot-desktop')            # Compose projects: earlier apps used the folder's name, newer ones 'openbot-desktop'
$Machine = 'openbot'                                   # the Podman machine OpenBot creates (acquire::MACHINE)
$HostName = 'ai.copilotkit.openbot.recorder'

function Say($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" }
function Act([string]$what, [scriptblock]$do) {
  if ($DryRun) { Note "would $what" } else { Note $what; & $do }
}
function Gone([string[]]$paths) {
  foreach ($p in $paths) {
    if (Test-Path -LiteralPath $p) { Act "remove $p" { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue } }
  }
}
function Has-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# The CLI OpenBot itself runs, so logout and delete speak the same version.
# NOT named `Cli`: PowerShell resolves aliases before functions, and `cli` is Clear-Item.
function Invoke-BundledCli {
  $node = Join-Path $AppDir 'cli-bundle\runtime\node.exe'
  $entry = Join-Path $AppDir 'cli-bundle\cli\index.js'
  if ((Test-Path $node) -and (Test-Path $entry)) { & $node $entry @args } else { & npx --yes copilotkit @args }
}

$engines = @()
if (Has-Command docker) { docker info *> $null; if ($LASTEXITCODE -eq 0) { $engines += 'docker' } }
if (Has-Command podman) { podman info *> $null; if ($LASTEXITCODE -eq 0) { $engines += 'podman' } }

$stack = $null
if ($StackId) { $stack = $StackId }
$record = Join-Path $Root '.openbot-local-eval.json'
if (-not $stack -and (Test-Path $record)) {
  $state = Get-Content -Raw $record | ConvertFrom-Json
  if ($state.ownership -eq 'created') { $stack = $state.stack }
}

Say 'Plan'
Note ("engines answering: " + $(if ($engines) { $engines -join ', ' } else { 'none' }))
Note ("Intelligence stack OpenBot created: " + $(if ($stack) { $stack } else { 'none recorded' }))
if ($RemoveApp) { Note "also uninstalling the app from $AppDir" }
if ($Images) { Note 'also removing OpenBot images (published and local)' }
if (-not $DryRun -and -not $Yes) {
  $answer = Read-Host 'Reset OpenBot completely? [y/N]'
  if ($answer -notmatch '^[yY]') { Write-Host 'Nothing changed.'; exit 1 }
}

Say 'Closing OpenBot'
# The app has no command to quit from outside; what its Quit would clean up is removed below.
$running = Get-Process -Name 'openbot-desktop' -ErrorAction SilentlyContinue
if ($running) { Act 'stop openbot-desktop' { $running | Stop-Process -Force } } else { Note 'not running' }

# Host processes run from the deployment folder (the person's browser, the sign-in helper).
Say "Stopping processes left running from $Root"
Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith("$Root\", 'OrdinalIgnoreCase')) -or
  ($_.CommandLine -and $_.CommandLine.IndexOf("$Root\", [StringComparison]::OrdinalIgnoreCase) -ge 0)
} | ForEach-Object {
  $proc = $_
  Act "stop pid $($proc.ProcessId) ($($proc.Name))" { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
}

# The CLI's sign-in service runs detached from the app's bundled node.exe and outlives the app.
Say 'Stopping the bundled CLI''s background processes'
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$AppDir\cli-bundle\*" } | ForEach-Object {
  $proc = $_
  Act "stop pid $($proc.Id) ($($proc.Path))" { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

Say 'Deleting the Intelligence stack OpenBot created'
if (-not $stack) {
  Note 'none recorded; other stacks are left alone'
} elseif ($DryRun) {
  Note "would run: cli local delete --stack $stack --confirm-delete $stack --json"
} else {
  foreach ($attempt in 1..4) {
    $global:LASTEXITCODE = 1
    $out = Invoke-BundledCli local delete --stack $stack --confirm-delete $stack --json 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { Note "deleted $stack"; break }
    if ($out -match 'local_command_busy' -and $attempt -lt 4) { Note 'CLI busy, retrying in 30s'; Start-Sleep 30; continue }
    Note "could not delete ${stack}:"; Note $out.Trim(); break
  }
  # Whatever the CLI managed: remove anything of this stack's k3d cluster still on the engine.
  foreach ($engine in $engines) {
    $ids = @(& $engine ps -aq --filter "name=^k3d-$stack-") | Where-Object { $_ }
    if ($ids) { Act "remove $stack's cluster containers" { & $engine rm -f @ids | Out-Null } }
    $vols = @(& $engine volume ls -q | Where-Object { $_ -like "k3d-$stack*" })
    if ($vols) { Act "remove $stack's cluster volumes" { & $engine volume rm -f @vols | Out-Null } }
    $nets = @(& $engine network ls --format '{{.Name}}' | Where-Object { $_ -like "k3d-$stack*" })
    if ($nets) { Act "remove $stack's cluster network" { & $engine network rm @nets | Out-Null } }
  }
}

Say 'Signing the CopilotKit CLI out and clearing the evaluation agreement'
if ($DryRun) { Note 'would run: cli logout' } else { $global:LASTEXITCODE = 1; Invoke-BundledCli logout *> $null; if ($LASTEXITCODE -eq 0) { Note 'signed out' } else { Note "logout exited $LASTEXITCODE" } }
# Only this file: the same folder keeps the records of your other stacks.
$eula = foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
  $dir = Join-Path $base 'copilotkit-config-nodejs'
  if (Test-Path $dir) { Get-ChildItem -Path $dir -Recurse -Filter 'eula-acceptance.json' -File -ErrorAction SilentlyContinue | ForEach-Object FullName }
}
if ($eula) { Gone $eula } else { Note 'no acceptance on record' }

foreach ($engine in $engines) {
  Say "Removing OpenBot's containers, volumes and networks on $engine"
  $ids = @(foreach ($p in $Projects) { & $engine ps -aq --filter "label=com.docker.compose.project=$p" }) + @(& $engine ps -aq --filter 'name=^openbot-') | Where-Object { $_ } | Sort-Object -Unique
  if ($ids) { Act "remove containers $($ids -join ' ')" { & $engine rm -f @ids | Out-Null } }
  $vols = @(foreach ($p in $Projects) { & $engine volume ls -q --filter "label=com.docker.compose.project=$p" }) + @(& $engine volume ls -q | Where-Object { $_ -match '^openbot[_-]' }) | Where-Object { $_ } | Sort-Object -Unique
  if ($vols) { Act "remove volumes $($vols -join ' ')" { & $engine volume rm -f @vols | Out-Null } }
  $nets = @(foreach ($p in $Projects) { & $engine network ls -q --filter "label=com.docker.compose.project=$p" }) | Where-Object { $_ } | Sort-Object -Unique
  if ($nets) { Act "remove networks $($nets -join ' ')" { & $engine network rm @nets | Out-Null } }
  if ($Images) {
    $imgs = @(& $engine images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -match '(^|/)openbot(-[a-z0-9-]+)?:' }) | Sort-Object -Unique
    if ($imgs) { Act "remove images $($imgs -join ' ')" { & $engine rmi -f @imgs | Out-Null } }
  }
  if (-not ($ids -or $vols -or $nets)) { Note 'nothing there' }
}

if (Has-Command podman) {
  podman machine inspect $Machine *> $null
  if ($LASTEXITCODE -eq 0) {
    Say "Removing the Podman machine OpenBot created ($Machine)"
    Act "remove podman machine $Machine" { podman machine rm -f $Machine | Out-Null }
  }
}

Say "Removing OpenBot's files and registry entries"
Gone @(
  $Root,
  (Join-Path $env:APPDATA $BundleId),
  (Join-Path $env:LOCALAPPDATA $BundleId),          # app data and the WebView2 profile
  (Join-Path $AppDir 'recorder'),                   # the Recorder's host manifest
  (Join-Path $AppDir 'local-computer')              # OpenBot's own browser profile
)
foreach ($vendor in @('Google\Chrome', 'Microsoft\Edge', 'Chromium')) {
  $key = "HKCU:\Software\$vendor\NativeMessagingHosts\$HostName"
  if (Test-Path $key) { Act "remove registry key $key" { Remove-Item -Path $key -Recurse -Force } }
}
$runOnce = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
if (Get-ItemProperty -Path $runOnce -Name 'OpenBot' -ErrorAction SilentlyContinue) {
  Act 'remove the RunOnce entry OpenBot left for a restart' { Remove-ItemProperty -Path $runOnce -Name 'OpenBot' }
}

if ($RemoveApp) {
  Say 'Uninstalling the app'
  $uninstaller = Join-Path $AppDir 'uninstall.exe'
  if (Test-Path $uninstaller) {
    Act "run $uninstaller /S" { Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait }
  } else { Note "no uninstaller at $uninstaller" }
}

Say 'Done. Open OpenBot from the Start menu to start from the beginning.'
