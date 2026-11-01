# OpenBot Desktop on Intel Macs (fork notes)

Upstream CI only builds on `macos-latest` (Apple Silicon). This fork adds
`.github/workflows/macos-intel.yml`, which cross-compiles `x86_64-apple-darwin` and produces a DMG.

## Build
GitHub > Actions > **macOS Intel build** > *Run workflow* (tick *publish* for a pre-release).
Or locally on an Intel Mac:

    rustup target add x86_64-apple-darwin
    cd desktop && bun install --frozen-lockfile
    bun scripts/desktop-version.ts internal
    APPLE_SIGNING_IDENTITY=- bun run tauri build --target x86_64-apple-darwin --bundles dmg \
      --config src-tauri/tauri.build-version.conf.json

## Known limitation
`desktop/src-tauri/src/install.rs` refuses to auto-install the container engine on Intel
(Podman publishes arm64 only). Install **Docker Desktop** (or Podman Desktop) manually first.

## First launch
The build is ad-hoc signed, not notarized: right-click > Open, or
`xattr -dr com.apple.quarantine /Applications/OpenBot.app`.
