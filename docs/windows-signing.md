# Windows desktop signing

The [Desktop Windows signing workflow](../.github/workflows/desktop-signing.yml)
builds OpenBot and its NSIS installer with the existing DigiCert certificate in
Azure Key Vault. It retains verified binaries and signature evidence as Actions
artifacts for 14 days. It does not create or publish a release. Desktop version
`0.0.0` remains a validation build.

Ordinary Desktop CI and fork PR builds remain unsigned. The
`tauri.windows-signing.conf.json` overlay is passed explicitly to Tauri only by
the protected signing job. Do not rename it `tauri.windows.conf.json`: Tauri
automatically merges that filename into every Windows build.

## Request a signed validation build

Before this workflow is merged to `main`, add the `windows-signing` label to a
same-repository PR and approve its `windows-signing` environment deployment.
The workflow checks out the exact PR head SHA from the labeling event. New
pushes run the regression job; remove and reapply the label to sign the new SHA.
Fork PRs cannot enter this signing job. There is no `pull_request_target` trigger.

After merge, use **Actions → Desktop Windows signing → Run workflow**, select the
ref to validate, and set `signing-mode` to `keyvault`. The default `none` runs
only credential-free regressions. Environment reviewers should check the exact
source SHA and workflow changes before approving access to the publisher's key.

A successful signing run extracts `openbot-desktop.exe` from the NSIS installer
with 7-Zip, then verifies **both** that payload and the single `*-setup.exe`
installer using Windows Authenticode and
`signtool verify /pa /all /v /tw`. Signatures must be valid, timestamped, and have
publisher `Tawkit, Inc.`. Any warning or nonzero SignTool exit fails the job.
`signatures.json` records the source SHA, artifact SHA-256 hashes, signer and
timestamp certificates; the companion text files retain verbose SignTool output.
The binaries upload only after both pass. The extracted app is retained from
`desktop/signed-app/`: Tauri restores the unsigned build executable after bundling,
so verifying `target/release/openbot-desktop.exe` would inspect the wrong copy.
These checks do not test SmartScreen reputation or exercise the app UI.

## One-time infrastructure setup

Use the protected GitHub environment `windows-signing` with required reviewers.
Configure these environment **variables**; they contain public identifiers, not
passwords:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | `cb923310-e793-4557-929e-b33e49a42297` |
| `AZURE_TENANT_ID` | `c3050389-57ad-4c62-8dcd-fe5e2af4fbce` |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing `cpk-signing-kv` |
| `AZURE_KEY_VAULT_URL` | `https://cpk-signing-kv.vault.azure.net` |
| `CODE_SIGNING_CERT_NAME` | `code-signing` |

An owner of the existing Entra application, or an appropriately authorized
application administrator, must add the federated credential. From the repo root:

```sh
az ad app federated-credential create \
  --id cb923310-e793-4557-929e-b33e49a42297 \
  --parameters desktop/signing/azure-federation.json
```

Check existing credentials first; do not duplicate or replace another repository's
credential. The subject in the checked-in JSON is OpenBot's verified immutable
subject, including owner and repository IDs, scoped to this environment. An
`Insufficient privileges` response requires an authorized app owner/administrator
to run the command; GitHub environment approval does not grant Entra permissions.

The existing signing identity needs certificate read and key sign permissions.
With Key Vault RBAC, **Key Vault Certificate User** plus **Key Vault Crypto User**
cover these operations; Crypto User alone does not grant certificate read access.
Reuse the existing certificate and permissions where already provisioned. No
client secret, exported private key, PFX, or Tauri updater signing key is needed.

The workflow pins Azure Login and AzureSignTool 7.0.1, checks the downloaded
tool's SHA-256, and obtains Key Vault access tokens through GitHub OIDC. The
wrapper refreshes the token for each signing invocation, registers it for log
masking, and clears its process environment afterward. Tokens are never written
to workflow outputs, `GITHUB_ENV`, or artifacts. Tauri invokes the wrapper for
the app and installer, as well as NSIS components it needs to sign.

## Check the scripts

```sh
pwsh -NoProfile -File desktop/scripts/test-windows-signing.ps1
```

The regression suite uses synthetic command results to test missing config,
native failures, unsigned/altered signatures, publisher mismatch, absent
timestamps, absent/stale installers, and evidence for both files. It runs on
Windows PR CI without Azure access. Only a protected signing run proves the
certificate, OIDC federation, and real Windows signature chain together.

References: [Tauri custom signing](https://v2.tauri.app/distribute/sign/windows/),
[AzureSignTool 7.0.1](https://github.com/vcsjones/AzureSignTool/tree/v7.0.1),
[Windows SignTool verification](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool),
[GitHub OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc),
[Entra federated credentials](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust).
