# macOS microphone verification

`src-tauri/Info.plist` supplies the microphone and speech recognition permission
descriptions. Tauri merges
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
plutil -extract NSSpeechRecognitionUsageDescription raw src-tauri/target/release/bundle/macos/OpenBot.app/Contents/Info.plist
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/OpenBot.app
codesign -d --entitlements - src-tauri/target/release/bundle/macos/OpenBot.app
codesign -dv src-tauri/target/release/bundle/macos/OpenBot.app
```

Both descriptions must be nonempty (without the speech one, asking for speech
recognition ends the app), the signed entitlement
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

5. Teach a Bot narration (on-device, `src-tauri/src/speech.rs`): open Teach a Bot,
   name a task, leave Narration on and press Record. macOS asks for speech
   recognition, then the microphone (the first time only). Allow both. The page
   says "Narration is on. We're capturing your voice." and keeps saying it. Say
   a sentence, pause, say another, then Stop: the saved recording counts the
   narrated phrases. If either permission was denied, the page says "Narration
   is off."; allow OpenBot under System Settings → Privacy & Security → Speech
   Recognition and Microphone, then turn Narration on again.
6. Repeat step 5 with the Mac offline (Wi-Fi off). Narration must still work:
   every request requires on-device recognition, so none of it uses the network.
   If the Mac has no on-device model for the language (System Settings →
   Keyboard → Dictation shows the languages), narration is off.
7. Read `~/Library/Logs/OpenBot/speech.log` (`src-tauri/src/speech/diagnostics.rs`):
   one line per thing narration did, never a word said. Expect the permission
   states, the microphone's format, its loudness every 5 s (speech near the
   microphone is louder than about -35 dBFS), each phrase's first words and its
   final character count, any recognizer error code, and the end. A phrase that
   reached the page and went on to the Recorder shows as a `POST` to
   `/api/browser/narration` answered 200 in the web view's network log:
   `/usr/bin/log show --predicate 'process == "com.apple.WebKit.Networking" AND eventMessage CONTAINS "transaction summary"'`.

Record the tested app build, macOS version, prompt result, and results for all
four capture paths. An ad-hoc build does not verify Developer ID signing or
notarization; repeat on the signed distribution artifact before release.

References: [Tauri native configuration and entitlements](https://v2.tauri.app/distribute/macos-application-bundle/#native-configuration),
[WebKit's usage-description requirement](https://bugs.webkit.org/show_bug.cgi?id=217104).
