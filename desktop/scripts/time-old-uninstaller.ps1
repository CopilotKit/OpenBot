#Requires -Version 7.0
# One-off measurement, not a test: where OpenBot 1.0.1's uninstaller spends its time when an
# installer runs it as an update (`uninstall.exe /UPDATE /S _?=<folder>`). Prints each part.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$url = 'https://github.com/CopilotKit/OpenBot/releases/download/v1.0.1/OpenBot_1.0.1_x64-setup.exe'
$sha256 = 'A433C05BE29AD77D3BF0D62F4295736C35A10A5482788AB3AA86E45756F5740D'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenBot'
$locationKey = 'HKCU:\Software\CopilotKit\OpenBot'
$work = Join-Path $env:RUNNER_TEMP 'openbot-1.0.1'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$setup = Join-Path $work 'OpenBot_1.0.1_x64-setup.exe'

function Seconds([scriptblock]$Block) { [math]::Round((Measure-Command $Block).TotalSeconds, 2) }
function Pending {
    $value = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -ErrorAction SilentlyContinue).PSObject.Properties['PendingFileRenameOperations']
    if ($value) { @($value.Value).Count } else { 0 }
}

if (Test-Path -LiteralPath $uninstallKey) { throw 'OpenBot is installed here already.' }
for ($try = 1; $try -le 5; $try++) {
    try { Invoke-WebRequest -Uri $url -OutFile $setup; break } catch { if ($try -eq 5) { throw }; Start-Sleep -Seconds 10 }
}
if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ne $sha256) { throw 'The 1.0.1 installer is not the published one.' }

try { Write-Host "Defender real-time protection: $((Get-MpComputerStatus).RealTimeProtectionEnabled)" } catch { Write-Host 'Defender status unavailable.' }
Write-Host "Install 1.0.1 silently: $(Seconds { Start-Process -FilePath $setup -ArgumentList '/S' -Wait }) s"
$folder = (Get-Item -LiteralPath $locationKey).GetValue('')
Write-Host "Files installed: $(@(Get-ChildItem -LiteralPath $folder -Recurse -File).Count), folders: $(@(Get-ChildItem -LiteralPath $folder -Recurse -Directory).Count)"

# 1.0.1's NSIS_HOOK_PREUNINSTALL: the 32-bit PowerShell stop of the bundled CLI, as its hook runs it.
$powershell32 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
$stop = '$bundle = $env:OPENBOT_CLI_BUNDLE.TrimEnd(''\'') + ''\''; Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($bundle, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Stop-Process -Force -PassThru -ErrorAction SilentlyContinue | ForEach-Object { $null = $_.WaitForExit(30000) }'
$env:OPENBOT_CLI_BUNDLE = Join-Path $folder 'cli-bundle'
Write-Host "32-bit PowerShell stop of the bundled CLI, first: $(Seconds { & $powershell32 -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $stop }) s"
Write-Host "32-bit PowerShell stop of the bundled CLI, again: $(Seconds { & $powershell32 -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $stop }) s"

$before = Pending
Write-Host "1.0.1 uninstaller as an update (/UPDATE /S): $(Seconds { Start-Process -FilePath (Join-Path $folder 'uninstall.exe') -ArgumentList "/UPDATE /S _?=$folder" -Wait }) s"
Write-Host "Files left: $(@(Get-ChildItem -LiteralPath $folder -Recurse -File).Count), delete-at-restart entries added: $((Pending) - $before)"

Write-Host "Install 1.0.1 again: $(Seconds { Start-Process -FilePath $setup -ArgumentList '/S' -Wait }) s"
Write-Host "Deleting cli-bundle with Remove-Item alone: $(Seconds { Remove-Item -LiteralPath (Join-Path $folder 'cli-bundle') -Recurse -Force }) s"

# Leave nothing behind.
Start-Process -FilePath (Join-Path $folder 'uninstall.exe') -ArgumentList "/S _?=$folder" -Wait
Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $locationKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
