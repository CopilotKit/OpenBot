#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:WINDOWS_SIGNING -ne 'keyvault') {
    throw 'Signing requires WINDOWS_SIGNING=keyvault.'
}
foreach ($name in @('AZURE_KEY_VAULT_URL', 'CODE_SIGNING_CERT_NAME')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "Missing required signing configuration: $name"
    }
}
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Signing input does not exist: $Path"
}
$file = (Resolve-Path -LiteralPath $Path).Path
Get-Command az, AzureSignTool.exe -ErrorAction Stop | Out-Null

# Request at each invocation: Tauri may spend a long time building before it signs.
# Never put this token in GITHUB_ENV, outputs, a transcript, or a file. AzureSignTool
# accepts it through -kva; Tauri sees only this wrapper's non-secret command line.
try {
    $env:AZURE_ACCESS_TOKEN = az account get-access-token --resource https://vault.azure.net --query accessToken --output tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($env:AZURE_ACCESS_TOKEN)) {
        throw 'Could not obtain an Azure Key Vault access token.'
    }
    Write-Host "::add-mask::$env:AZURE_ACCESS_TOKEN"
    & AzureSignTool.exe sign -fd sha256 -tr http://timestamp.digicert.com -td sha256 `
        -kvu $env:AZURE_KEY_VAULT_URL -kvc $env:CODE_SIGNING_CERT_NAME `
        -kva $env:AZURE_ACCESS_TOKEN -d OpenBot $file
    if ($LASTEXITCODE -ne 0) {
        throw "AzureSignTool failed for $file (exit $LASTEXITCODE)."
    }
} finally {
    Remove-Item Env:AZURE_ACCESS_TOKEN -ErrorAction SilentlyContinue
}
