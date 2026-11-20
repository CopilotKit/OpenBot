# Windows desktop signing

Builds use the release after the root OpenBot release number plus `-internal.<commits>.g<commit>`
(`0.3.4-internal.…` after 0.3.3), or the plain release number when the run is on a release tag. The workflow verifies
that both the packaged app and installer embed that version, and includes `build-version.json`
with the binaries. See [desktop build versions](releasing.md#desktop-build-versions).

The [Desktop Windows signing workflow](../.github/workflows/desktop-signing.yml)
builds OpenBot and its NSIS installer with the existing DigiCert certificate in
Azure Key Vault. It retains verified binaries and signature evidence as Actions
artifacts for 14 days. It does not create a release, but it can attach its signed
installer to one that exists: see [Sign a release](#sign-a-release).

Ordinary Desktop CI and fork PR builds remain unsigned. The
`tauri.windows-signing.conf.json` overlay is passed explicitly to Tauri only by
the protected signing job. Do not rename it `tauri.windows.conf.json`: Tauri
automatically merges that filename into every Windows build.

## Request a signed validation build

To sign a pull request's build, add the `windows-signing` label to a
same-repository PR and approve its `windows-signing` environment deployment.
The workflow checks out the exact PR head SHA from the labeling event. New
pushes run the regression job; remove and reapply the label to sign the new SHA.
Fork PRs cannot enter this signing job. There is no `pull_request_target` trigger.

To sign any ref, use **Actions → Desktop Windows signing → Run workflow**, select the
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

## Sign a release

Every release starts this workflow. As soon as `publish-release.yml` has created the tag and
the release, right after the images, it dispatches this workflow on the tag with
`signing-mode: keyvault` and `release-tag` set to that version. The tag alone would not start it: GitHub starts no
workflow from a push made with `GITHUB_TOKEN`, and this workflow has no tag trigger anyway.
The run still waits for a `windows-signing` reviewer to approve it.

On a tag, the build carries the plain release version, the same as a candidate's unsigned
installer, and is built by
[`desktop/scripts/signed-build.ts`](../desktop/scripts/signed-build.ts), as the signed Mac
build is. A candidate or beta is pinned to its release's own `container-images.json`, like
its unsigned installer, and the Intelligence CLI is bundled whenever the tree has
`tauri.bundled-cli.conf.json`. After the signing job verifies the installer, a separate
job with permission to write to the repository attaches it to the release with `--clobber`,
twice: as `OpenBot_<version>_x64-setup.exe`, replacing a candidate's unsigned installer of
the same name, and as `OpenBot-windows-x64-setup.exe`, the fixed name a web page links to. A
stable release has no other Windows installer: this is the only one it carries. See
[Download links](releasing.md#download-links). The signing job itself never holds that
permission. A stable release becomes Latest once both this and Mac signing have attached their
signed installers, in whichever of the two finishes second, so the Windows address never gives the
unsigned installer. Set `make-latest` when signing a release again by hand for it to do that. See
[Which release is Latest](releasing.md#which-release-is-latest).

To sign a release again by hand, use **Actions → Desktop Windows signing → Run workflow**,
choose the release tag under **Use workflow from**, set `signing-mode` to `keyvault`, and
set `release-tag` to the same tag. A run from anywhere else builds an internal version, and
the attach job refuses it, because its version is not the tag's. A candidate's signing run
also refuses a `container-images.json` from another commit. To attach again after the
signing job succeeded, re-run only the failed attach job: it uses the installer that attempt
signed. [`desktop/scripts/publish-signed-windows.sh`](../desktop/scripts/publish-signed-windows.sh)
is the attach step.

## Updates

A signed Windows app updates itself the way a signed Mac app does: it reads the same `latest.json`
at launch and every six hours, shows **OpenBot X is available** with **Update and restart** in
OpenBot's window and the setup window, and installs only on that click. See
[The updater](releasing.md#the-updater). `tauri.windows-signing.conf.json` carries the same
`plugins.updater` block as the Mac overlay (public key and endpoints), plus
`windows.installMode: passive`.

The Windows updater installs the NSIS installer itself, so the release's signed `-setup.exe` is
the update. For a run that attaches to a release, the **Sign the installer for the updater** job
downloads the installer the signing job verified, signs exactly those bytes with
`tauri signer sign` and the updater key, and checks the signature against `plugins.updater.pubkey`
with minisign
([`desktop/scripts/sign-windows-update.sh`](../desktop/scripts/sign-windows-update.sh)). The key is
the Mac's, and it is kept only in the `macos-signing` environment, so that job runs there and waits
for a `macos-signing` reviewer. The attach job then uploads `OpenBot_<version>_x64-setup.exe.sig`
and lists the installer in `latest.json` as `windows-x86_64`, beside the Mac archives. A candidate
or beta is pinned, has no updater, and skips that job.

**Update and restart** downloads and verifies the installer while OpenBot keeps running, then stops
OpenBot (the local Intelligence keeps running). The updater starts the installer in update mode and
the app exits at once; the installer stops anything still running from the bundled CLI, replaces the
app, and starts the new version, whose Start moves the installation to its release. The installer
is per user, so no administrator prompt appears, and update mode never runs the uninstaller, so the
installation and the app's data stay where they are.

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
client secret, exported private key, PFX, or Tauri updater signing key is needed in
this environment: the updater key stays in `macos-signing` (see [Updates](#updates)).

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
