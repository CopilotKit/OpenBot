---
name: agui-tauri-windows-signing
description: >
  Configure and troubleshoot Authenticode code signing for Tauri Windows
  builds (.exe / .msi) using the AG-UI organization's DigiCert code-signing
  certificate stored in Azure Key Vault (non-exportable RSA-HSM key), signed
  via AzureSignTool authenticated with GitHub OIDC. Covers tauri.conf.json
  signCommand wiring, the CI signing seam (mode gate: none | keyvault), the
  separation between Authenticode signing, Tauri updater (minisign) keys,
  and NuGet package author signing, plus the Azure/Entra access model —
  including what changes when the Tauri app lives in a DIFFERENT repository
  than the existing NuGet signing lane. USE FOR: adding Windows signing to
  a Tauri app, wiring the release workflow to the vault (same repo or
  cross-repo), debugging signature, login, permission, or SmartScreen
  failures, or answering "which cert / which key / which tool / which
  access right signs what".
---

# Tauri Windows Signing with Azure Key Vault

## Context: what signs what

The org's signing infrastructure has **three independent mechanisms**. Never
conflate them — they use different keys, different tools, and different
verification paths:

| Mechanism | Key | Tool | Applies to |
|---|---|---|---|
| NuGet **author signature** | DigiCert cert, CN=Tawkit, Inc. — private key in Azure Key Vault (non-exportable, RSA-HSM) | `NuGetKeyVaultSignTool` | `*.nupkg` only |
| **Authenticode** (this skill) | Same DigiCert cert, same vault | `AzureSignTool` | Windows PE binaries: `.exe`, `.dll`, `.msi` (incl. Tauri builds) |
| Assembly strong-naming | `AGUI.snk` | MSBuild | .NET assemblies; unrelated to either signature |
| Tauri **updater** signature | Tauri minisign key pair (NOT the vault cert) | `tauri signer` | Update manifests for `tauri-plugin-updater` |

Additional facts that agents routinely get wrong:

- nuget.org applies its own **repository signature** automatically on push.
  The author signature is what flips a package to "signed" on the gallery;
  it is not needed for Authenticode at all.
- Symbol packages (`*.snupkg`) are **intentionally not** author-signed.
- The vault certificate: DigiCert Trusted G4 Code Signing RSA4096 SHA384
  2021 CA1 issuer chain, OV validation. Because it is OV (not EV), Windows
  SmartScreen reputation builds per-publisher over signed releases rather
  than being granted instantly — an unsigned-looking warning on a brand-new
  app is expected until reputation accrues, and is not a signing failure.
- The private key **never leaves the HSM**. Every signature — NuGet or
  Authenticode — is a `keys/sign` operation executed inside the vault.
  Never attempt to export the key or generate a `.pfx`.

Reference implementation for the NuGet lane (the pattern this skill mirrors):
`.github/workflows/publish-release.yml` (signing step) and
`sdks/dotnet/docs/signing.md` (design doc).

## Task: wire signing into a Tauri build

### 1. Point `signCommand` at a wrapper script

In `tauri.conf.json`, override the default `signtool.exe` invocation.
Tauri calls this command once per binary **and** once per installer,
substituting `%1` with each file path:

```json
{
  "bundle": {
    "windows": {
      "signCommand": "pwsh ./scripts/sign-tauri.ps1 %1"
    }
  }
}
```

Do NOT configure the legacy `certificateThumbprint` / `digestAlgorithm` /
`timestampUrl` fields — those expect a locally installed certificate with a
locally accessible key and cannot reach a Key Vault HSM.

### 2. Create the wrapper script

`scripts/sign-tauri.ps1` — mirrors the NuGetKeyVaultSignTool step in
`publish-release.yml` (same vault URL, cert name, token, digest, and
timestamp authority):

```powershell
param([string]$File)
azuresigntool sign `
  -fd sha256 `
  -tr http://timestamp.digicert.com `
  -td sha256 `
  -kvu $env:AZURE_KEY_VAULT_URL `
  -kvc $env:CODE_SIGNING_CERT_NAME `
  -kva $env:AZURE_ACCESS_TOKEN `
  $File
if ($LASTEXITCODE -ne 0) { throw "Signing failed for $File" }
```

Flag mapping from the NuGet lane (verify you kept them identical):

| NuGetKeyVaultSignTool | AzureSignTool |
|---|---|
| `--file-digest sha256` | `-fd sha256` |
| `--timestamp-rfc3161 http://timestamp.digicert.com` | `-tr http://timestamp.digicert.com` |
| `--timestamp-digest sha256` | `-td sha256` |
| `--azure-key-vault-url` | `-kvu` |
| `--azure-key-vault-certificate` | `-kvc` |
| `--azure-key-vault-accesstoken` | `-kva` |

### 3. Wire the workflow with OIDC (no long-lived secrets)

The release job authenticates to Azure with GitHub OIDC federation — the
same pattern as the NuGet lane. Do not introduce a client secret.

```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_SIGNING_CLIENT_ID }}   # federated to GH OIDC
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    allow-no-subscriptions: true
- run: dotnet tool install --global AzureSignTool
- run: |
    $env:AZURE_ACCESS_TOKEN = (az account get-access-token `
      --resource https://vault.azure.net --query accessToken -o tsv)
    npm run tauri build
```

The workflow job MUST declare `permissions: id-token: write` (with
`contents: read`) — without it GitHub will not issue an OIDC token at all.
This is the single most common cause of a first-run login failure in a new
workflow or repo.

### 4. Keep the mode gate (safe default)

Follow the established `signing-mode` seam from `publish-release.yml`:
the workflow input defaults to `none` (unsigned, safe to merge before any
vault is provisioned) and only `keyvault` enables signing. For Tauri,
implement the gate by either:

- merging a `tauri.windows.conf.json` overlay containing the `signCommand`
  only in the release job, or
- omitting `signCommand` from the base config and signing the built
  `.exe` / `.msi` as an explicit post-build step when mode = keyvault.

Both are acceptable; the invariant is that an unprovisioned environment
never fails (or silently signs) because the seam exists.

## Access rights: what changes and what doesn't

The vault-side permission model is **identical** for NuGet signing and
Authenticode. AzureSignTool requires exactly: **Key: Sign**, **Secret:
Get**, **Certificate: Get** — the same three operations NuGetKeyVaultSignTool
already performs on every release. Therefore:

- **No new Azure RBAC role assignments** are needed (existing Key Vault
  Crypto User, or legacy access policy, already covers the operations).
- **No vault configuration changes** — same vault, same certificate, same
  `keys/sign` operation.
- **No new access policies, no key export, no `.pfx` generation.**

The ONLY thing that may need an Entra ID change is the **federated
credential** that maps GitHub OIDC tokens to the app registration, and only
when the Tauri build runs from somewhere the current credential does not
cover.

### Same repo / same environment → change nothing

If the Tauri signing job runs in `ag-ui-protocol/ag-ui` under the same
environment or ref as the existing NuGet signing job, the existing
federated credential covers it. The existing `AZURE_SIGNING_CLIENT_ID`
and `AZURE_TENANT_ID` just work.

### Different repo → add one federated credential

Federated credential subjects are **exact-match only** — no wildcards, no
org-wide `repo:org/*` coverage. A credential scoped to
`repo:ag-ui-protocol/ag-ui:...` does not cover any other repository. On
the SAME app registration the NuGet lane uses, add a new federated
credential:

- **Issuer:** `https://token.actions.githubusercontent.com`
- **Audience:** `api://AzureADTokenExchange`
- **Subject:** the new repo's token subject, e.g.
  `repo:other-org/tauri-app:environment:release` or
  `repo:other-org/tauri-app:ref:refs/heads/main`

Subject format caveat (important for 2026+): repositories created after
July 15, 2026 emit an **immutable subject format** by default —
`repo:owner@owner-id/repo@repo-id:ref:...` with numeric IDs embedded.
If the Tauri repo is brand new, its OIDC token's `sub` claim uses that
format and the credential subject must match it exactly. Before creating
the credential, run a debug workflow that requests the OIDC token and
prints the `sub` claim; copy it verbatim.

Alternative for many repos: Entra **flexible federation** (claims-matching
expressions) allows a single credential to cover multiple repositories —
prefer it when a third or fourth signing repo becomes likely.

### Cross-repo checklist (complete)

In the OTHER repository:

1. Add the federated credential on the existing app registration (above).
2. Set repo secrets/variables: `AZURE_TENANT_ID`, `AZURE_SIGNING_CLIENT_ID`
   (same values as the ag-ui repo), plus `AZURE_KEY_VAULT_URL` and
   `CODE_SIGNING_CERT_NAME`. Secrets do NOT share across repos — either
   recreate them per repo, or hoist the non-sensitive values (tenant ID,
   client ID, vault URL, cert name) to organization-level Actions
   variables so both repos read one source of truth.
3. Create the signing environment (e.g., `release`) if the credential
   subject is environment-scoped, and apply protection rules to it.
4. Declare `permissions: id-token: write` on the signing job.
5. Install AzureSignTool in the job: `dotnet tool install --global AzureSignTool`.
6. Add the `tauri.conf.json` signCommand + wrapper script (repo-local).

### Blast radius: shared identity vs separate identity

Adding the credential to the existing app registration means the Tauri
repo shares the exact identity that can invoke `keys/sign` on the org's
code-signing key: anyone who can trigger the signing job in that repo can
sign anything with the Tawkit cert. Since the cert is OV, SmartScreen
reputation accrues to the shared publisher — a compromised signing job in
any repo damages the org's whole signing reputation. Mitigations that cost
nothing in Azure:

- Scope the federated credential to a **protected environment** (subject
  `...:environment:release`) with required reviewers, rather than a plain
  branch ref, so signing only runs after approval.
- Keep the `signing-mode: none | keyvault` gate in the new repo, matching
  the ag-ui seam, so unprovisioned PRs can never trigger signing.

If isolation is required instead, create a SEPARATE app registration for
the Tauri repo — this is the one variant that DOES require new Azure
access rights, because the new service principal must be granted Key Vault
Crypto User on the vault manually.

## Verification

After a build, verify before publishing:

```powershell
# Authenticode + certificate chain + RFC 3161 timestamp
signtool verify /pa /v /all path\to\App.exe

# PowerShell alternative
Get-AuthenticodeSignature path\to\App.exe | Format-List

# Expected: Status Valid, SignerCertificate subject CN=Tawkit, Inc.,
# TimeStamperCertificate from DigiCert, timestamped within the cert validity.
```

For NuGet packages (separate lane, same vault):
`dotnet nuget verify Package.nupkg --verbosity detailed`.

Bringing a new repo online, in order:

1. Debug workflow: request the OIDC token and print the `sub` claim.
2. Create the federated credential with that exact subject.
3. `azure/login`, then read-only smoke test:
   `az keyvault certificate show --vault-name <vault> --name <cert>`.
4. If the smoke test passes, `keys/sign` will pass too — the sign
   permission is already proven by every NuGet release.
5. Full `tauri build` with signing enabled.

## Failure modes and diagnosis

- **azure/login "federated credential not found"**: subject mismatch. Print
  the job's `sub` claim and compare character-for-character with the
  credential subject — watch for the immutable format
  (`owner@owner-id/repo@repo-id`) on repos created after 2026-07-15, and
  for environment vs ref scoping.
- **OIDC token not issued / login gets no token**: the job lacks
  `permissions: id-token: write`.
- **"signCommand" not invoked / binaries unsigned**: check that the config
  landed under `bundle.windows` (not a v1-style top-level `windows` key),
  and that the command exits 0 — a non-zero exit fails the bundle step.
- **AzureSignTool not found**: it must be installed as a `dotnet tool` on
  the runner in the same job that runs the build.
- **401 / invalid token from the vault**: the access token must be scoped
  to `https://vault.azure.net` (Key Vault resource), not Azure Graph or
  management endpoints. Re-check the `--resource` in the token command.
- **403 on sign in a NEW repo but not the old one**: unexpected — same SPN,
  same operations. Check whether someone created a separate app registration
  for the new repo instead of reusing the existing one; if so, that SPN
  needs Key Vault Crypto User on the vault.
- **Signature valid locally but SmartScreen still warns**: expected for OV
  certificates on new apps. It is a reputation state, not a defect — do not
  "fix" it by changing certificates or re-signing repeatedly.
- **Updater verification failing**: updater signatures come from the
  Tauri minisign key pair (`tauri signer generate`), never from the vault
  cert. Generate and configure them separately if updater support is needed.
