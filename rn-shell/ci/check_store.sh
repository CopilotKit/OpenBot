#!/usr/bin/env bash
# What a STORE build of the RN shell ships (built without EXPO_PUBLIC_OPENBOT_TEST_BUILD). Run from rn-shell/.
#   check_store.sh config  <artifacts>  prebuild both platforms; no ATS exception, no URL scheme, no cleartext
#   check_store.sh bundles <artifacts>  the store JavaScript (iOS and Android) has no test hook in it
#   check_store.sh apk     <artifacts>  builds the Android store APK (arm64-v8a), checks its manifest and bundle, sizes it
set -euo pipefail
mode="$1"; ART="$2"; mkdir -p "$ART"
unset EXPO_PUBLIC_OPENBOT_TEST_BUILD
# The names only a test build may contain (src/testHooks.ts, the debug label, the log prefix).
HOOKS='openbot\.base_url|openbot\.test_session_cookie|openbot\.plain_session_cookie|openbot\.probe_url|openbot\.force_offline|launchArguments|debug-state|OPENBOT_DIAG'
report() { echo "$1" | tee -a "$ART/STORE.md"; }

case "$mode" in
  config)
    npx expo prebuild --no-install --clean > "$ART/prebuild-store.log" 2>&1
    python3 - "$ART" <<'PY'
import plistlib, sys, re
art = sys.argv[1]
plist = plistlib.load(open("ios/OpenBot/Info.plist", "rb"))
problems = []
if "NSAppTransportSecurity" in plist: problems.append(f"iOS: App Transport Security exception {plist['NSAppTransportSecurity']}")
if plist.get("CFBundleURLTypes"): problems.append(f"iOS: URL schemes {plist['CFBundleURLTypes']}")
if plist.get("UISupportedInterfaceOrientations") != ["UIInterfaceOrientationPortrait"]: problems.append("iOS: not portrait only")
manifest = open("android/app/src/main/AndroidManifest.xml").read()
if 'android:usesCleartextTraffic="false"' not in manifest: problems.append("Android: cleartext not refused")
if "networkSecurityConfig" in manifest: problems.append("Android: a network security config (the test build's) in the store build")
if "openbotshell" in manifest: problems.append("Android: the callback scheme is on MainActivity (it belongs to the trampoline)")
if 'android:allowBackup="false"' not in manifest: problems.append("Android: backup allowed")
with open(f"{art}/STORE.md", "a") as out:
    out.write("## Store configuration\n\n")
    out.write("- iOS Info.plist: no App Transport Security exception, no URL scheme, portrait only\n" if not any(p.startswith("iOS") for p in problems) else "")
    out.write("- Android manifest: usesCleartextTraffic=false, no network security config, backup off\n" if not any(p.startswith("Android") for p in problems) else "")
    for p in problems: out.write(f"- PROBLEM: {p}\n")
for p in problems: print("::error::" + p)
sys.exit(1 if problems else 0)
PY
    ;;
  bundles)
    report "## Store JavaScript"
    for platform in ios android; do
      npx expo export:embed --platform "$platform" --dev false --minify true --reset-cache \
        --bundle-output "$ART/store.$platform.js" --assets-dest "$ART/store-assets-$platform" > /dev/null 2>&1
      found="$(grep -oE "$HOOKS" "$ART/store.$platform.js" | sort -u | tr '\n' ' ' || true)"
      if [ -n "$found" ]; then echo "::error::the $platform store bundle has test hooks: $found"; exit 1; fi
      report "- $platform: $(wc -c < "$ART/store.$platform.js") bytes, none of the test hooks' names"
    done
    # The same grep finds them in a test build, so it would catch them.
    EXPO_PUBLIC_OPENBOT_TEST_BUILD=1 npx expo export:embed --platform android --dev false --minify true --reset-cache \
      --bundle-output "$ART/test.android.js" --assets-dest "$ART/test-assets" > /dev/null 2>&1
    count="$(grep -oE "$HOOKS" "$ART/test.android.js" | sort -u | wc -l)"
    [ "$count" -ge 5 ] || { echo "::error::the grep does not find the hooks in a test build ($count)"; exit 1; }
    report "- control: the test build's bundle has $count of the names"
    rm -f "$ART"/store.*.js "$ART"/test.android.js
    ;;
  apk)
    npx expo prebuild --platform android --no-install --clean > /dev/null 2>&1
    sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g/' android/gradle.properties
    (cd android && ./gradlew --no-daemon :app:assembleRelease -PreactNativeArchitectures=arm64-v8a > "$ART/gradle-store.log" 2>&1) \
      || { tail -n 100 "$ART/gradle-store.log"; exit 1; }
    apk=android/app/build/outputs/apk/release/app-release.apk
    aapt2="$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 | sort -V | tail -1)"
    "$aapt2" dump xmltree --file AndroidManifest.xml "$apk" > "$ART/store-manifest.txt"
    grep -q 'usesCleartextTraffic.*=false' "$ART/store-manifest.txt" || { echo "::error::the store APK does not refuse cleartext"; exit 1; }
    if grep -q networkSecurityConfig "$ART/store-manifest.txt"; then echo "::error::the store APK has a network security config"; exit 1; fi
    if grep -q 'android:debuggable.*=true' "$ART/store-manifest.txt"; then echo "::error::the store APK is debuggable"; exit 1; fi
    unzip -p "$apk" assets/index.android.bundle > "$ART/store-bundle.hbc"
    found="$(strings -a "$ART/store-bundle.hbc" | grep -oE "$HOOKS" | sort -u | tr '\n' ' ' || true)"
    rm -f "$ART/store-bundle.hbc"
    if [ -n "$found" ]; then echo "::error::the store APK's Hermes bundle has test hooks: $found"; exit 1; fi
    size="$(stat -c %s "$apk")"
    report "## Android store APK (arm64-v8a, R8 off as in Expo's default, Hermes)"
    report "- $(awk -v s="$size" 'BEGIN { printf "%.1f MB", s / 1048576 }') ($size bytes); manifest refuses cleartext, not debuggable; no test hook in its bundle"
    unzip -l "$apk" | sort -k1 -n -r | head -12 > "$ART/store-apk-largest.txt"
    ;;
esac
