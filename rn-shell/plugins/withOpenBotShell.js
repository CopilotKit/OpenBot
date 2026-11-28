// The native settings `expo prebuild` cannot be told in app.config.ts, for the test build and the
// store build:
//
// - iOS: no URL scheme, portrait only, and App Transport Security. Expo's template allows local networking for its dev server; the
//   store build must have no exception at all, the test build only NSAllowsLocalNetworking (the http
//   mock stacks on localhost).
// - Android: cleartext. The store build says usesCleartextTraffic="false"; the test build gets a
//   network security config with cleartext only to localhost, 127.0.0.1 and 10.0.2.2.
const {
  withInfoPlist,
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const NETWORK_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<!-- TEST BUILD ONLY (rn-shell/plugins/withOpenBotShell.js): cleartext to this machine, for the mocks. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">10.0.2.2</domain>
    </domain-config>
</network-security-config>
`;

function withIosSettings(config, testBuild) {
  return withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    if (testBuild)
      plist.NSAppTransportSecurity = { NSAllowsLocalNetworking: true };
    else delete plist.NSAppTransportSecurity;
    // No URL scheme at all: Expo adds the bundle identifier as one, and the sign-in's callback
    // scheme must never be registered (only the ASWebAuthenticationSession the app started takes it).
    delete plist.CFBundleURLTypes;
    // A phone stays in portrait.
    plist.UISupportedInterfaceOrientations = ["UIInterfaceOrientationPortrait"];
    plist.UIRequiresFullScreen = true;
    return mod;
  });
}

function withCleartext(config, testBuild) {
  config = withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      mod.modResults,
    );
    if (testBuild) {
      application.$["android:networkSecurityConfig"] =
        "@xml/network_security_config";
      delete application.$["android:usesCleartextTraffic"];
    } else {
      application.$["android:usesCleartextTraffic"] = "false";
      delete application.$["android:networkSecurityConfig"];
    }
    return mod;
  });
  if (!testBuild) return config;
  return withDangerousMod(config, [
    "android",
    async (mod) => {
      const dir = path.join(
        mod.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "network_security_config.xml"),
        NETWORK_CONFIG,
      );
      return mod;
    },
  ]);
}

module.exports = function withOpenBotShell(config, props = {}) {
  const testBuild = Boolean(props.testBuild);
  config = withIosSettings(config, testBuild);
  config = withCleartext(config, testBuild);
  return config;
};
