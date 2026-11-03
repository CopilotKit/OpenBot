# Launch without onboarding or the dev menu

When you launch Expo Go or a development build yourself, suppress the onboarding sheet, the dev menu at launch, and the Tools button with launch flags. Don't change app config for this.

**SDK 58+:** Expo CLI adds the flags itself when it has no TTY (force with `EXPO_NO_DEV_MENU=1`). For URLs you open yourself, append `__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1` to `exp://<host>:8081` or `<scheme>://?__expo_url=<encoded dev server URL>`.

**SDK 57 and earlier, iOS:** launch with these arguments before opening the URL. They last for that process only.

```bash
xcrun simctl launch --terminate-running-process booted <bundle id> \
  -EXDevMenuIsOnboardingFinished 1 -EXDevMenuShowsAtLaunch 0 -EXDevMenuShowFloatingActionButton 0
```

**SDK 57 and earlier, Android:** append `&disableOnboarding=1&disableFab=1&disableAutoLaunch=1` to `<scheme>://expo-development-client/?url=<encoded dev server URL>`. Only `disableOnboarding` works before `expo-dev-launcher` 57.0.20. Expo Go has no flag, so dismiss its onboarding once.

**Opening URLs:** on Android, use `adb shell "am start -a android.intent.action.VIEW -d '<url>'"`. The inner quotes keep the URL's `&`. On iOS, `simctl openurl` shows an "Open in '<app>'?" prompt for any scheme not yet approved. Approve it first:

```bash
P=~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/Preferences/com.apple.launchservices.schemeapproval.plist
K="com.apple.CoreSimulator.CoreSimulatorBridge--><scheme>"
/usr/libexec/PlistBuddy -c "Set :'$K' <bundle id>" "$P" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :'$K' string <bundle id>" "$P"
```

Expo Go's bundle id is `host.exp.Exponent`, and its scheme is `exp`.
