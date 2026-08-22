# Mobile App Guide

OpenBot ships as both a **Progressive Web App (PWA)** and an **Android APK** via Trusted Web Activity (TWA). No native code to maintain — the same React app powers everything.

## PWA — Install on any device

The web manifest and service worker are included automatically. Users can install OpenBot from their browser:

- **Android (Chrome)**: tap the "Add to home screen" banner or use the browser menu → Install app
- **iOS (Safari)**: Share → Add to Home Screen
- **Desktop**: click the install icon in the address bar

The service worker caches the shell so the app loads instantly and stays usable offline (reads from cache; writes queue until connectivity returns).

## Android APK (TWA)

The APK is a thin Android shell that loads your deployed OpenBot instance inside Chrome, with no address bar. This gives users a native-feeling experience with full system integration (push notifications, share targets, etc.).

### Prerequisites

1. A deployed OpenBot instance accessible over HTTPS at a real domain (e.g. `app.example.com`).
2. A GitHub repository with Actions enabled.

### One-time setup

#### 1 — Update the package name

Open `twa/twa-manifest.json` and set:

```json
"packageId": "com.yourcompany.openbot",
"host": "app.example.com"
```

#### 2 — Wire up Digital Asset Links

TWA requires your domain to declare the APK's signing certificate. The placeholder is at `app/public/.well-known/assetlinks.json`.

Get your SHA-256 fingerprint after the first build:

```sh
keytool -printcert -jarfile openbot-release.apk
```

Then replace `REPLACE_WITH_YOUR_SHA256_FINGERPRINT` in `assetlinks.json` with the colon-separated hex string (e.g. `AB:CD:EF:...`).

#### 3 — Store the signing keystore as a secret

In GitHub → Settings → Secrets → Actions, add:

| Secret | Value |
|--------|-------|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 your.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (default: `openbot`) |
| `ANDROID_KEY_PASSWORD` | key password |

If the secret is absent the workflow generates a throwaway keystore and warns — fine for a trial build, but you will lose Play Store update rights if you lose the keystore.

### Building the APK

**On demand:**

1. Go to Actions → "Build Android APK (TWA)"
2. Click "Run workflow"
3. Enter your domain (e.g. `app.example.com`)
4. The signed APK uploads as a workflow artifact.

**On release:**

Every time a GitHub Release is published the workflow runs automatically and attaches `openbot-release.apk` to the release assets.

### Distributing

- Side-load directly: share the APK file; users enable "Install unknown apps" once.
- Google Play: create a release in the Play Console and upload the signed APK/AAB. Set the package name to match `packageId`.
