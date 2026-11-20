#Requires -Version 7.0
# The Windows installer this build made, run on the runner as a person runs it.
#
# Installing over an installed OpenBot runs the old version's uninstaller first. It must run
# silently and as an update (/UPDATE /S, NSIS_HOOK_PREINSTALL in src-tauri/windows/hooks.nsh): no
# "Delete the application data" box in the middle of an update, and the data kept. And the
# installer's own window must stay on screen while it runs: hidden, a person saw nothing at all for
# minutes and took it for a crash. A passive install of the same version over itself takes that
# path with nothing to click: "Already Installed", then the old version uninstalled first.
#
# The old uninstaller is done in well under a tenth of a second, so looking for its process every few
# milliseconds saw it once on most runs and not at all on some, and the test then failed having
# checked nothing. So the installer is held where it runs the old uninstaller instead. The command
# it runs is the UninstallString in OpenBot's uninstall registry key, and for this one install that
# is a script of this test's ($holdScript): it says the installer has asked for the old uninstaller,
# waits while the installer's window is checked, then runs the old uninstaller with exactly what the
# installer gave it and exits as it did. Three things tell how the old uninstaller ran:
#   - what the installer gave it: /UPDATE /S and the folder, as written down by the script;
#   - a value added to OpenBot's uninstall registry key is gone afterwards, since any uninstall
#     removes the key and the install writes it again without the value: the old uninstaller ran;
#   - OpenBot's start-at-sign-in value (HKCU Run) is still there, since only an uninstall that is
#     not an update removes it: the old uninstaller ran as an update.
# The app's data stays either way, and is checked too.
#
# Uninstalling runs the app headless to stop what OpenBot runs (--stop-for-uninstall, from
# NSIS_HOOK_PREUNINSTALL in windows/hooks.nsh). The installed app is run that way directly and must
# finish, with nothing failed and no window left open, and the uninstall that runs it must finish.
#
# Refuses to run where OpenBot is already installed, and takes away everything it added.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tauri = (Resolve-Path (Join-Path $PSScriptRoot '..\src-tauri')).Path
$product = 'OpenBot'
$binary = 'openbot-desktop'
$bundleId = 'ai.copilotkit.openbot.desktop'
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$locationKey = "HKCU:\Software\CopilotKit\$product"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$marker = 'OpenBotUpdateCheck'
$scratch = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

# Run a program and wait for it, at most $Seconds. Answers its exit code.
function Invoke-Waited([string]$File, [string]$Arguments, [int]$Seconds, [string]$Output = '') {
    $start = @{ FilePath = $File; ArgumentList = $Arguments; PassThru = $true }
    if ($Output) {
        $start.RedirectStandardOutput = $Output
        $start.NoNewWindow = $true
    }
    $process = Start-Process @start
    $null = $process.Handle
    if (-not $process.WaitForExit($Seconds * 1000)) {
        $process.Kill($true)
        throw "$File $Arguments did not finish in $Seconds seconds."
    }
    $process.ExitCode
}

# What the installer runs as the old uninstaller while it is watched, with what the installer gave
# it as its arguments. It writes those down, says it was asked for ({NAME}-asked), waits to be let
# go ({NAME}-go), then runs the old uninstaller in the folder it was given (`_?=`, last) with the
# same arguments, and exits as it did.
$holdScript = @'
$ErrorActionPreference = 'Stop'
$given = $args -join ' '
Set-Content -LiteralPath "$PSCommandPath.given" -Value $given
$asked = [System.Threading.EventWaitHandle]::OpenExisting('{NAME}-asked')
$go = [System.Threading.EventWaitHandle]::OpenExisting('{NAME}-go')
$null = $asked.Set()
if (-not $go.WaitOne(900000)) { exit 98 }
$at = $given.IndexOf('_?=')
if ($at -lt 0) { exit 97 }
$old = Start-Process -FilePath (Join-Path $given.Substring($at + 3) 'uninstall.exe') -ArgumentList $given -PassThru
$null = $old.Handle
$old.WaitForExit()
Set-Content -LiteralPath "$PSCommandPath.exit" -Value $old.ExitCode
exit $old.ExitCode
'@

# Run an installer and watch it. Once it has asked for the old uninstaller ($Asked), which waits
# until it is let go ($Go), note several times whether the installer has a window on screen.
# Answers its exit code and the notes: none when it never asked for the old uninstaller.
function Invoke-Watched(
    [string]$File,
    [string]$Arguments,
    [System.Threading.EventWaitHandle]$Asked,
    [System.Threading.EventWaitHandle]$Go,
    [int]$Seconds
) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    $null = $process.Handle
    $shown = [System.Collections.Generic.List[bool]]::new()
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    try {
        while (-not $Asked.WaitOne(50) -and -not $process.HasExited) {
            if ([DateTime]::UtcNow -gt $deadline) {
                $process.Kill($true)
                throw "$File $Arguments did not finish in $Seconds seconds."
            }
        }
        if ($Asked.WaitOne(0)) {
            # The installer is waiting for the old uninstaller, for as long as this takes.
            foreach ($check in 1..10) {
                # A process's main window is its first top-level window that is shown.
                $process.Refresh()
                $shown.Add($process.MainWindowHandle -ne [IntPtr]::Zero)
                Start-Sleep -Milliseconds 20
            }
        }
    }
    finally {
        $null = $Go.Set()
    }
    while (-not $process.WaitForExit(1000)) {
        if ([DateTime]::UtcNow -gt $deadline) {
            $process.Kill($true)
            throw "$File $Arguments did not finish in $Seconds seconds."
        }
    }
    [pscustomobject]@{ ExitCode = $process.ExitCode; Shown = $shown }
}

function Get-Value([string]$Key, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Key)) { return $null }
    (Get-Item -LiteralPath $Key).GetValue($Name)
}

$installers = @(Get-ChildItem -LiteralPath (Join-Path $tauri 'target\release\bundle\nsis') -Filter '*-setup.exe')
Assert-True ($installers.Count -eq 1) "Expected one installer, found $($installers.Count)."
$installer = $installers[0].FullName

Assert-True (-not (Test-Path -LiteralPath $uninstallKey)) 'OpenBot is already installed here. This test installs and uninstalls it, so it will not run.'
$runBefore = Get-Value $runKey $product
# A fresh Windows account may have no Run key at all until something starts at sign-in.
$runKeyMade = -not (Test-Path -LiteralPath $runKey)
if ($runKeyMade) { New-Item -Path $runKey -Force | Out-Null }
$dataFolders = @((Join-Path $env:APPDATA $bundleId), (Join-Path $env:LOCALAPPDATA $bundleId))
$dataBefore = @($dataFolders | Where-Object { Test-Path -LiteralPath $_ })
$installDir = $null
$hold = Join-Path $scratch "openbot-old-uninstaller-$PID.ps1"
$holdName = "OpenBotUpdateCheck-$PID"
$asked = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, "$holdName-asked")
$go = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, "$holdName-go")

try {
    # 1. Install.
    $code = Invoke-Waited $installer '/S' 900
    Assert-True ($code -eq 0) "Installing exited with $code."
    $installDir = Get-Value $locationKey ''
    Assert-True ([bool]$installDir) "Installing wrote no install location under $locationKey."
    $app = Join-Path $installDir "$binary.exe"
    Assert-True (Test-Path -LiteralPath $app) "Installing left no $app."
    Write-Host "Installed in $installDir."

    # 2. What the old uninstaller removes, and what it removes only when it is not an update.
    New-ItemProperty -LiteralPath $uninstallKey -Name $marker -Value 1 -PropertyType DWord | Out-Null
    New-ItemProperty -LiteralPath $runKey -Name $product -Value 'openbot-update-check' -PropertyType String -Force | Out-Null
    foreach ($folder in $dataFolders) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $folder 'update-check.txt') -Value 'kept'
    }

    # 3. The same installer again, over itself, passively, held where it runs the old uninstaller
    # and watched there. The install writes OpenBot's own UninstallString again.
    Set-Content -LiteralPath $hold -Value $holdScript.Replace('{NAME}', $holdName)
    $shell = (Get-Process -Id $PID).Path
    Set-ItemProperty -LiteralPath $uninstallKey -Name 'UninstallString' -Value "`"$shell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$hold`""
    $watched = Invoke-Watched $installer '/P' $asked $go 900
    Assert-True ($watched.ExitCode -eq 0) "Installing over OpenBot exited with $($watched.ExitCode)."
    $hidden = @($watched.Shown | Where-Object { -not $_ }).Count
    Write-Host "While the installer waited for the old uninstaller, its window was checked $($watched.Shown.Count) times and was hidden $hidden of them."
    Assert-True ($watched.Shown.Count -gt 0) 'The installer never asked for the old uninstaller, so this test checked nothing.'
    Assert-True ($hidden -eq 0) 'The installer hid its window while the old uninstaller ran: a person sees nothing on screen and takes it for a crash.'
    $given = (Get-Content -Raw -LiteralPath "$hold.given").Trim()
    Assert-True ($given -eq "/UPDATE /S _?=$installDir") "The installer ran the old uninstaller with '$given': not silently, as an update, in $installDir."
    $ended = if (Test-Path -LiteralPath "$hold.exit") { (Get-Content -Raw -LiteralPath "$hold.exit").Trim() } else { 'no exit code' }
    Assert-True ($ended -eq '0') "The old uninstaller ended with $ended."
    Assert-True (Test-Path -LiteralPath $uninstallKey) 'Installing over OpenBot left it uninstalled.'
    Assert-True (Test-Path -LiteralPath $app) "Installing over OpenBot left no $app."
    Assert-True ($null -eq (Get-Value $uninstallKey $marker)) 'Installing over OpenBot did not run the old uninstaller first, so this test checked nothing.'
    Assert-True ((Get-Value $runKey $product) -eq 'openbot-update-check') 'The old uninstaller ran as a full uninstall (it removed OpenBot''s start at sign-in), not as an update: it shows its window, offers to delete the data, and deletes it when ticked.'
    foreach ($folder in $dataFolders) {
        Assert-True (Test-Path -LiteralPath (Join-Path $folder 'update-check.txt')) "Installing over OpenBot deleted $folder."
    }
    Write-Host 'Installing over OpenBot ran the old uninstaller silently, as an update, and kept the data.'

    # 4. The uninstall's stop, run as the uninstaller runs it.
    $output = Join-Path $scratch 'openbot-stop-for-uninstall.txt'
    $code = Invoke-Waited $app '--stop-for-uninstall' 360 $output
    $said = if (Test-Path -LiteralPath $output) { Get-Content -Raw -LiteralPath $output } else { '' }
    Write-Host "$binary --stop-for-uninstall said: $said"
    Assert-True ($code -eq 0) "$binary --stop-for-uninstall exited with $code."
    Assert-True (-not (Get-Process -Name $binary -ErrorAction SilentlyContinue)) "$binary --stop-for-uninstall left the app running."

    # 5. Uninstall silently, waited for (`_?=`, last, unquoted, as NSIS reads it).
    $code = Invoke-Waited (Join-Path $installDir 'uninstall.exe') "/S _?=$installDir" 900
    Assert-True ($code -eq 0) "Uninstalling exited with $code."
    Assert-True (-not (Test-Path -LiteralPath $uninstallKey)) 'Uninstalling left OpenBot installed.'
    Assert-True (-not (Test-Path -LiteralPath $app)) "Uninstalling left $app."
    Write-Host 'Uninstalled, with the stop run first.'
}
finally {
    # Nothing this test started is left waiting on it.
    $null = $go.Set()
    foreach ($file in $hold, "$hold.given", "$hold.exit") {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    if ($installDir -and (Test-Path -LiteralPath $uninstallKey)) {
        try { $null = Invoke-Waited (Join-Path $installDir 'uninstall.exe') "/S _?=$installDir" 900 } catch { Write-Warning $_ }
    }
    if ($installDir -and (Test-Path -LiteralPath $installDir)) {
        Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($runKeyMade) {
        Remove-Item -LiteralPath $runKey -Recurse -Force -ErrorAction SilentlyContinue
    }
    elseif ($null -eq $runBefore) {
        Remove-ItemProperty -LiteralPath $runKey -Name $product -ErrorAction SilentlyContinue
    }
    else {
        New-ItemProperty -LiteralPath $runKey -Name $product -Value $runBefore -PropertyType String -Force | Out-Null
    }
    foreach ($folder in $dataFolders) {
        if ($dataBefore -notcontains $folder) {
            Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
        }
        else {
            Remove-Item -LiteralPath (Join-Path $folder 'update-check.txt') -Force -ErrorAction SilentlyContinue
        }
    }
}

# What the build generated: Tauri's script from OpenBot's template, and the hooks it includes.
$generated = Join-Path $tauri 'target\release\nsis\x64\installer.nsi'
Assert-True (Test-Path -LiteralPath $generated) "No generated installer script at $generated."
$script = Get-Content -Raw -LiteralPath $generated
Assert-True ($script.Contains('StrCpy $OpenBotUninstallFirst 1')) 'The generated installer runs the old uninstaller from the Already Installed page, with its window hidden.'
Assert-True ($script.Contains('!insertmacro OPENBOT_BEFORE_OLD_UNINSTALLER')) 'The generated installer does not ask before closing OpenBot.'
$include = [regex]::Match($script, '!include "([^"]*hooks\.nsh)"')
Assert-True $include.Success 'The generated installer does not include windows\hooks.nsh.'
$hooks = Get-Content -Raw -LiteralPath $include.Groups[1].Value
Assert-True ($hooks.Contains("ExecWait '`$OpenBotOldUninstaller /UPDATE /S _?=`$OpenBotOldFolder'")) 'The included hooks do not run the old uninstaller with /UPDATE /S.'
Assert-True ($hooks.Contains('!insertmacro OPENBOT_PROGRESS_MOVING 1')) 'The included hooks show no moving progress while the old uninstaller runs.'
Assert-True ($hooks.Contains('!macro NSIS_HOOK_PREUNINSTALL') -and $hooks.Contains('--stop-for-uninstall')) 'The included hooks do not stop OpenBot on uninstall.'
Write-Host 'The generated installer uninstalls the old version on the Installing page with /UPDATE /S and includes the uninstall stop.'

Write-Host 'Windows installer update regression passed.'
