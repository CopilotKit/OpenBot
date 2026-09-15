#Requires -Version 7.0
# Command-boundary regressions; no Azure credentials, certificate store changes,
# network calls, or real signatures. The protected job verifies real artifacts.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-Throws([scriptblock]$Operation, [string]$Message) {
    try { & $Operation | Out-Null } catch {
        if ($_.Exception.Message -notlike "*$Message*") { throw }
        $script:passed++
        return
    }
    throw "Expected failure containing: $Message"
}

$directory = Join-Path ([System.IO.Path]::GetTempPath()) "openbot signing $([Guid]::NewGuid())"
$installerDirectory = Join-Path $directory 'installers'
$evidenceDirectory = Join-Path $directory 'evidence'
New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null
$app = Join-Path $directory 'OpenBot app.exe'
$installer = Join-Path $installerDirectory 'OpenBot test-setup.exe'
Set-Content -LiteralPath $app -Value 'unsigned app fixture'
Set-Content -LiteralPath $installer -Value 'unsigned installer fixture'
$environmentNames = @('WINDOWS_SIGNING', 'AZURE_KEY_VAULT_URL', 'CODE_SIGNING_CERT_NAME', 'AZURE_ACCESS_TOKEN')
$originalEnvironment = @{}
foreach ($name in $environmentNames) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

# Native exit statuses are separate from PowerShell exceptions. These stubs
# exercise exactly that boundary, including a successful command with empty output.
$global:SigningTestState = @{
    azExit = 0; signExit = 0; verifyExit = 0; token = 'synthetic-test-token'
    signCalls = 0; signArguments = @(); verifyCalls = @(); status = 'Valid'
    publisher = 'Tawkit, Inc.'; timestamp = $true; invalidFile = ''
    productVersion = '0.0.10-internal.gabcdef012345'; fileVersion = '0.0.10-internal.gabcdef012345'; wrongVersionFile = ''
}
function global:Get-Item {
    param([string]$LiteralPath)
    $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath
    if ($item -is [System.IO.FileInfo]) {
        $wrong = $LiteralPath -eq $global:SigningTestState.wrongVersionFile
        return [pscustomobject]@{
            Name = $item.Name
            FullName = $item.FullName
            VersionInfo = [pscustomobject]@{
                ProductVersion = if ($wrong) { $global:SigningTestState.productVersion } else { '0.0.10-internal.gabcdef012345' }
                FileVersion = if ($wrong) { $global:SigningTestState.fileVersion } else { '0.0.10-internal.gabcdef012345' }
            }
        }
    }
    $item
}
function global:az {
    $global:LASTEXITCODE = $global:SigningTestState.azExit
    $global:SigningTestState.token
}
function global:AzureSignTool.exe {
    $global:SigningTestState.signCalls++
    $global:SigningTestState.signArguments = $args
    $global:LASTEXITCODE = $global:SigningTestState.signExit
}
function global:Test-SignTool {
    $global:SigningTestState.verifyCalls += ,$args
    $global:LASTEXITCODE = $global:SigningTestState.verifyExit
    'Synthetic SignTool verification output'
}
function global:Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    $certificate = [pscustomobject]@{ Subject = 'CN="Tawkit, Inc."'; Thumbprint = 'TEST-CERTIFICATE' }
    $certificate | Add-Member ScriptMethod GetNameInfo { return $global:SigningTestState.publisher }
    [pscustomobject]@{
        Status = if ($global:SigningTestState.invalidFile -eq '' -or $LiteralPath -eq $global:SigningTestState.invalidFile) { $global:SigningTestState.status } else { 'Valid' }
        SignerCertificate = $certificate
        TimeStamperCertificate = if ($global:SigningTestState.timestamp) { $certificate } else { $null }
    }
}

try {
    $sign = Join-Path $PSScriptRoot 'sign-windows.ps1'
    $verify = Join-Path $PSScriptRoot 'verify-windows-signatures.ps1'
    $verifyParameters = @{
        AppPath = $app; InstallerDirectory = $installerDirectory
        EvidenceDirectory = $evidenceDirectory; SignToolPath = 'Test-SignTool'; SourceSha = 'test-source-sha'
    }
    $env:WINDOWS_SIGNING = ''
    Assert-Throws { & $sign -Path $app } 'WINDOWS_SIGNING=keyvault'
    $env:WINDOWS_SIGNING = 'keyvault'
    foreach ($missing in @('AZURE_KEY_VAULT_URL', 'CODE_SIGNING_CERT_NAME')) {
        $env:AZURE_KEY_VAULT_URL = 'https://test.vault.azure.net'
        $env:CODE_SIGNING_CERT_NAME = 'test-certificate'
        [Environment]::SetEnvironmentVariable($missing, '')
        Assert-Throws { & $sign -Path $app } "Missing required signing configuration: $missing"
    }
    $env:CODE_SIGNING_CERT_NAME = 'test-certificate'
    Assert-Throws { & $sign -Path (Join-Path $directory 'absent.exe') } 'Signing input does not exist'
    Assert-True ($global:SigningTestState.signCalls -eq 0) 'Refused input reached signer.'
    $global:SigningTestState.azExit = 1
    Assert-Throws { & $sign -Path $app } 'Could not obtain'
    Assert-True ([string]::IsNullOrEmpty($env:AZURE_ACCESS_TOKEN)) 'Token survived failed acquisition.'
    $global:SigningTestState.azExit = 0
    $global:SigningTestState.token = ''
    Assert-Throws { & $sign -Path $app } 'Could not obtain'
    $global:SigningTestState.token = 'synthetic-test-token'
    $global:SigningTestState.signExit = 1
    Assert-Throws { & $sign -Path $app } 'AzureSignTool failed'
    Assert-True ([string]::IsNullOrEmpty($env:AZURE_ACCESS_TOKEN)) 'Token survived signer failure.'
    $global:SigningTestState.signExit = 0
    $signOutput = & $sign -Path $app 6>&1 | Out-String
    Assert-True ($signOutput.Contains('::add-mask::synthetic-test-token')) 'Token was not registered for masking.'
    Assert-True ($global:SigningTestState.signArguments[-1] -eq $app) 'Path with spaces was split.'
    Assert-True ([string]::IsNullOrEmpty($env:AZURE_ACCESS_TOKEN)) 'Token survived successful signing.'
    $passed++

    # Both the app and installer must reject unsigned and tampered signatures.
    foreach ($invalidFile in @($app, $installer)) {
        $global:SigningTestState.invalidFile = $invalidFile
        foreach ($status in @('NotSigned', 'HashMismatch', 'NotTrusted')) {
            $global:SigningTestState.status = $status
            Assert-Throws { & $verify @verifyParameters } "Invalid Authenticode signature on $([System.IO.Path]::GetFileName($invalidFile)): $status"
        }
    }
    $global:SigningTestState.status = 'Valid'
    $global:SigningTestState.publisher = 'Tawkit, Inc. imposter'
    Assert-Throws { & $verify @verifyParameters } 'Unexpected publisher'
    $global:SigningTestState.publisher = 'Tawkit, Inc.'
    $global:SigningTestState.timestamp = $false
    Assert-Throws { & $verify @verifyParameters } 'Missing timestamp'
    $global:SigningTestState.timestamp = $true
    foreach ($verifyExit in @(1, 2)) {
        $global:SigningTestState.verifyExit = $verifyExit
        Assert-Throws { & $verify @verifyParameters } 'SignTool verification failed'
    }
    $global:SigningTestState.verifyExit = 0
    $global:SigningTestState.verifyCalls = @()
    & $verify @verifyParameters | Out-Null
    $report = Get-Content -LiteralPath (Join-Path $evidenceDirectory 'signatures.json') -Raw | ConvertFrom-Json
    Assert-True ($report.files.Count -eq 2 -and $report.sourceSha -eq 'test-source-sha') 'Evidence does not identify both files and source.'
    Assert-True ($report.files[0].sha256 -eq (Get-FileHash -LiteralPath $app).Hash) 'App evidence digest is incorrect.'
    Assert-True ($report.files[1].sha256 -eq (Get-FileHash -LiteralPath $installer).Hash) 'Installer evidence digest is incorrect.'
    Assert-True ($global:SigningTestState.verifyCalls.Count -eq 2) 'SignTool did not verify both files.'
    foreach ($call in $global:SigningTestState.verifyCalls) {
        Assert-True (($call[0..4] -join ' ') -eq 'verify /pa /all /v /tw') 'Trust or timestamp verification was omitted.'
    }
    $passed++
    $verifyParameters.ExpectedVersion = '0.0.10-internal.gabcdef012345'
    foreach ($wrongFile in @($app, $installer)) {
        $global:SigningTestState.wrongVersionFile = $wrongFile
        foreach ($field in @('productVersion', 'fileVersion')) {
            $global:SigningTestState[$field] = '0.0.0'
            Assert-Throws { & $verify @verifyParameters } 'Unexpected embedded version'
            $global:SigningTestState[$field] = $verifyParameters.ExpectedVersion
        }
    }
    $global:SigningTestState.wrongVersionFile = ''
    & $verify @verifyParameters | Out-Null
    $versionReport = Get-Content -LiteralPath (Join-Path $evidenceDirectory 'signatures.json') -Raw | ConvertFrom-Json
    foreach ($record in $versionReport.files) {
        Assert-True ($record.productVersion -ceq $verifyParameters.ExpectedVersion -and $record.fileVersion -ceq $verifyParameters.ExpectedVersion) 'Evidence omitted the embedded version.'
    }
    $passed++
    Remove-Item -LiteralPath $app
    Assert-Throws { & $verify @verifyParameters } 'Application executable is missing'
    Set-Content -LiteralPath $app -Value 'restored fixture'
    Remove-Item -LiteralPath $installer
    Assert-Throws { & $verify @verifyParameters } 'Expected exactly one NSIS installer'
    Set-Content -LiteralPath $installer -Value 'restored installer'
    Set-Content -LiteralPath (Join-Path $installerDirectory 'stale-setup.exe') -Value 'stale installer'
    Assert-Throws { & $verify @verifyParameters } 'Expected exactly one NSIS installer'

    # Tauri restores the unsigned build output after packaging. Exercise the
    # default paths against that real layout, without overriding AppPath.
    $layout = Join-Path $directory 'packaged desktop'
    $release = Join-Path $layout 'src-tauri/target/release'
    foreach ($relative in @('scripts', 'signed-app', 'src-tauri/target/release/bundle/nsis')) {
        New-Item -ItemType Directory -Path (Join-Path $layout $relative) -Force | Out-Null
    }
    Copy-Item -LiteralPath $verify -Destination (Join-Path $layout 'scripts/verify-windows-signatures.ps1')
    $restored = Join-Path $release 'openbot-desktop.exe'
    $payload = Join-Path $layout 'signed-app/openbot-desktop.exe'
    Set-Content -LiteralPath $restored -Value 'unsigned restored build output'
    Set-Content -LiteralPath $payload -Value 'signed installer payload'
    Set-Content -LiteralPath (Join-Path $release 'bundle/nsis/OpenBot test-setup.exe') -Value 'signed installer'
    $global:SigningTestState.invalidFile = $restored
    $global:SigningTestState.status = 'NotSigned'
    & (Join-Path $layout 'scripts/verify-windows-signatures.ps1') -SignToolPath Test-SignTool -SourceSha test-source-sha | Out-Null
    $payloadReport = Get-Content (Join-Path $layout 'signing-evidence/signatures.json') -Raw | ConvertFrom-Json
    Assert-True ($payloadReport.files[0].sha256 -eq (Get-FileHash -LiteralPath $payload).Hash) 'Default verification selected restored build output instead of installer payload.'
    $passed++

    $baseConfig = Get-Content "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json -AsHashtable
    Assert-True (-not $baseConfig.bundle.ContainsKey('windows') -or -not $baseConfig.bundle.windows.ContainsKey('signCommand')) 'Base Tauri build enables signing.'
    Assert-True (-not (Test-Path "$PSScriptRoot/../src-tauri/tauri.windows.conf.json")) 'Signing overlay could be loaded automatically.'
    $passed++
    Write-Host "Passed $passed Windows signing regression cases."
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name]) }
    Remove-Item Function:az, Function:AzureSignTool.exe, Function:Test-SignTool, Function:Get-AuthenticodeSignature, Function:Get-Item
    Remove-Variable SigningTestState -Scope Global
    Remove-Item -LiteralPath $directory -Recurse -Force
}
