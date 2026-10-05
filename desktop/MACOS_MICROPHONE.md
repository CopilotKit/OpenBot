# macOS microphone verification

`src-tauri/Info.plist` supplies the microphone permission description. Tauri merges
it with its generated metadata, including the `build-version.plist` overlay used
by CI. `bundle.macOS.entitlements` points to `Entitlements.plist`, which enables
audio input when the app is signed with hardened runtime.

Build and inspect an ad-hoc signed application from `desktop/`:

```sh
bun install --frozen-lockfile
bun test scripts/desktop-version.test.ts
bun scripts/desktop-version.ts internal
APPLE_SIGNING_IDENTITY=- bun run tauri build --config src-tauri/tauri.build-version.conf.json --bundles app
plutil -extract NSMicrophoneUsageDescription raw src-tauri/target/release/bundle/macos/OpenBot.app/Contents/Info.plist
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/OpenBot.app
codesign -d --entitlements - src-tauri/target/release/bundle/macos/OpenBot.app
codesign -dv src-tauri/target/release/bundle/macos/OpenBot.app
```

The description must be nonempty, the signed entitlement
`com.apple.security.device.audio-input` must be `true`, and the signature flags
must include `runtime`. The configuration regressions run in the existing desktop
version test suite. These checks validate packaging, not live microphone capture.

For a live check, use a Mac with a working microphone and configured voice
providers:

1. Launch the packaged `OpenBot.app`, complete setup, and open its workspace in
   the desktop window. Testing a browser tab or `tauri dev` does not verify the
   packaged application's permission.
2. Start dictation and approve OpenBot's macOS microphone prompt. Speak a short
   phrase, stop, and verify the transcription. If permission was already denied,
   enable OpenBot under System Settings → Privacy & Security → Microphone and
   reopen the app.
3. Start and stop an OpenAI voice conversation, then a Grok voice conversation.
   Verify each receives spoken input and releases the microphone after stopping.
4. Repeat with microphone permission denied and verify that the UI reports the
   failure instead of remaining in a recording state.

Record the tested app build, macOS version, prompt result, and results for all
three capture paths. An ad-hoc build does not verify Developer ID signing or
notarization; repeat on the signed distribution artifact before release.

References: [Tauri native configuration and entitlements](https://v2.tauri.app/distribute/macos-application-bundle/#native-configuration),
[WebKit's usage-description requirement](https://bugs.webkit.org/show_bug.cgi?id=217104).
