#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$AppPath = "$PSScriptRoot/../src-tauri/target/release/openbot-desktop.exe",
    [string]$InstallerDirectory = "$PSScriptRoot/../src-tauri/target/release/bundle/nsis",
    [string]$EvidenceDirectory = "$PSScriptRoot/../signing-evidence",
    [string]$SignToolPath,
    [string]$SourceSha = $env:SIGNING_SOURCE_SHA
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
    throw "Application executable is missing: $AppPath"
}
$installers = @(Get-ChildItem -LiteralPath $InstallerDirectory -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer, found $($installers.Count)."
}
if (-not $SignToolPath) {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) {
        $SignToolPath = $command.Source
    } else {
        $sdkTools = @(Get-ChildItem -Path "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" -File |
            Sort-Object FullName -Descending)
        if ($sdkTools.Count -eq 0) {
            throw 'Windows SDK signtool.exe was not found.'
        }
        $SignToolPath = $sdkTools[0].FullName
    }
}

New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$records = @()
foreach ($file in @((Get-Item -LiteralPath $AppPath), $installers[0])) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature on $($file.Name): $($signature.Status)"
    }
    $publisher = $signature.SignerCertificate.GetNameInfo(
        [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($publisher -cne 'Tawkit, Inc.') {
        throw "Unexpected publisher on $($file.Name): $publisher"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Missing timestamp on $($file.Name)."
    }

    # /pa applies Authenticode policy; /all checks every signature. /tw produces
    # exit 2 when a timestamp is absent, and warnings fail this gate too.
    $verification = & $SignToolPath verify /pa /all /v /tw $file.FullName 2>&1
    $verificationExit = $LASTEXITCODE
    $verification | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$($file.Name).signtool.txt")
    $verification | Write-Output
    if ($verificationExit -ne 0) {
        throw "SignTool verification failed for $($file.Name) (exit $verificationExit)."
    }
    $records += [ordered]@{
        file = $file.Name
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        status = [string]$signature.Status
        publisher = $publisher
        signerSubject = $signature.SignerCertificate.Subject
        signerThumbprint = $signature.SignerCertificate.Thumbprint
        timestampSubject = $signature.TimeStamperCertificate.Subject
        timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
        signtoolExitCode = $verificationExit
    }
}

[ordered]@{
    sourceSha = $SourceSha
    verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    files = $records
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'signatures.json')
Write-Host "Verified app and NSIS installer; evidence: $EvidenceDirectory"
