#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TestExecutable,
    [ValidateRange(10, 600)]
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# A limited token belonging to an administrator is not this regression boundary.
# Create a fresh account whose only local group is Users, and run the actual Rust test there.
$source = (Get-Item -LiteralPath $TestExecutable).FullName
$testName = 'windows::tests::native_standard_user_setup_probe'
$listed = & $source --list --ignored --exact $testName
if ($LASTEXITCODE -ne 0 -or $listed -notcontains "${testName}: test") {
    throw "The supplied executable does not contain the ignored native standard-user setup test."
}

$suffix = [Guid]::NewGuid().ToString('N')
$userName = "obci_$($suffix.Substring(0, 12))"
$directory = Join-Path $env:ProgramData "OpenBot-standard-user-$suffix"
$userCreated = $false
$directoryCreated = $false
$process = $null
$userSid = $null
$password = $null
$securePassword = $null
$passwordBytes = New-Object byte[] 48
$random = [Security.Cryptography.RandomNumberGenerator]::Create()

try {
    # The password only reaches the account/process APIs in memory. It is never written into the
    # wrapper, environment, command-line arguments, logs, or a credential file.
    $random.GetBytes($passwordBytes)
    $password = 'aZ9!' + [Convert]::ToBase64String($passwordBytes)
    $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
    $user = New-LocalUser -Name $userName -Password $securePassword `
        -Description 'OpenBot standard-user regression test' `
        -AccountExpires (Get-Date).AddHours(1)
    $userCreated = $true
    $userSid = $user.SID
    $usersSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-545'
    Add-LocalGroupMember -SID $usersSid -Member $user
    $memberships = @(Get-LocalGroup | Where-Object {
        @(Get-LocalGroupMember -SID $_.SID | Where-Object { $_.SID -eq $userSid }).Count -gt 0
    })
    if ($memberships.Count -ne 1 -or $memberships[0].SID -ne $usersSid) {
        throw 'The temporary account must belong only to the local Users group.'
    }

    New-Item -ItemType Directory -Path $directory | Out-Null
    $directoryCreated = $true
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', $userSid.Value)) {
        $rights = if ($sid -eq $userSid.Value) { 'Modify' } else { 'FullControl' }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            [Security.Principal.SecurityIdentifier]$sid, $rights,
            'ContainerInherit, ObjectInherit', 'None', 'Allow'
        )
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    Copy-Item -LiteralPath $source -Destination (Join-Path $directory 'native-test.exe')

    # Windows PowerShell is available to the new user without depending on the CI user's PATH.
    # This wrapper contains no credentials. Its output and atomic result file are the only IPC.
    $wrapper = @'
param([Parameter(Mandatory)][string]$ExpectedSid)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$exitCode = 1
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $ExpectedSid) { throw 'The test did not start as the temporary user.' }
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'The test process has administrator privileges.'
    }
    $profile = [Environment]::GetFolderPath('UserProfile')
    $registeredProfile = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$ExpectedSid").ProfileImagePath
    if (-not $profile -or $profile -ne [Environment]::ExpandEnvironmentVariables($registeredProfile)) {
        throw 'The temporary account profile was not loaded.'
    }
    if ($env:USERPROFILE -ne $profile -or
        $env:APPDATA -ne [Environment]::GetFolderPath('ApplicationData') -or
        $env:LOCALAPPDATA -ne [Environment]::GetFolderPath('LocalApplicationData')) {
        throw 'The test inherited folders from a different user profile.'
    }
    @{ identity = $identity.Name; sid = $ExpectedSid; profile = $env:USERPROFILE; elevated = $false } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'identity.log')
    $test = Start-Process -FilePath (Join-Path $PSScriptRoot 'native-test.exe') `
        -ArgumentList @('--ignored', '--exact', '--nocapture', 'windows::tests::native_standard_user_setup_probe') `
        -WorkingDirectory $PSScriptRoot -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput (Join-Path $PSScriptRoot 'stdout.log') `
        -RedirectStandardError (Join-Path $PSScriptRoot 'stderr.log')
    $exitCode = $test.ExitCode
} catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'wrapper-error.log')
} finally {
    @{ exitCode = $exitCode } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.tmp')
    Move-Item -LiteralPath (Join-Path $PSScriptRoot 'result.tmp') -Destination (Join-Path $PSScriptRoot 'result.json')
}
exit $exitCode
'@
    $wrapperPath = Join-Path $directory 'run.ps1'
    Set-Content -LiteralPath $wrapperPath -Value $wrapper -Encoding UTF8
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Run from the CI runner's administrator account, not LocalSystem. LoadUserProfile gives the
    # child its own HKCU hive, which setup reads to find the user's WSL configuration.
    # https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process
    $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$userName", $securePassword)
    $process = Start-Process -FilePath $powershell -Credential $credential -LoadUserProfile `
        -WorkingDirectory $directory -WindowStyle Hidden -PassThru `
        -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wrapperPath`" -ExpectedSid $($userSid.Value)"
    $password = $null
    $securePassword.Dispose()
    $securePassword = $null
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        throw "Standard-user setup test timed out after $TimeoutSeconds seconds."
    }
    $resultPath = Join-Path $directory 'result.json'
    if (-not (Test-Path -LiteralPath $resultPath)) {
        throw "Standard-user wrapper exited without a result (exit code: $($process.ExitCode))."
    }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.exitCode -ne 0) {
        throw "Standard-user setup test failed with exit code $($result.exitCode)."
    }
    $stdout = Get-Content -LiteralPath (Join-Path $directory 'stdout.log') -Raw
    if ($stdout -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;') {
        throw 'The standard-user executable did not report exactly one passing native test.'
    }
    Write-Host 'Verified Windows setup detection under a real standard-user account.'
} finally {
    $password = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    $random.Dispose()
    $cleanupErrors = @()
    if ($null -ne $process -and -not $process.HasExited) {
        try {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw 'Could not stop the native test process tree.' }
            if (-not $process.WaitForExit(10000)) { throw 'The native test process did not stop.' }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    if ($directoryCreated) {
        foreach ($name in @('identity.log', 'stdout.log', 'stderr.log', 'wrapper-error.log')) {
            $path = Join-Path $directory $name
            if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path }
        }
    }
    if ($userCreated) {
        try {
            Get-CimInstance Win32_UserProfile -Filter "SID='$($userSid.Value)'" | Remove-CimInstance
        } catch { $cleanupErrors += $_.Exception.Message }
        try { Remove-LocalUser -SID $userSid } catch { $cleanupErrors += $_.Exception.Message }
    }
    if ($directoryCreated) {
        try { Remove-Item -LiteralPath $directory -Recurse -Force } catch { $cleanupErrors += $_.Exception.Message }
    }
    if ($cleanupErrors.Count -gt 0) {
        throw "Standard-user test cleanup failed: $($cleanupErrors -join '; ')"
    }
}
