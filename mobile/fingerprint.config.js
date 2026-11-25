/**
 * What the app's runtime version is made from.
 *
 * The runtime version says which installed apps can take an update (app.config.ts, `runtimeVersion`). Expo computes
 * it as a fingerprint of everything that changes the native app: the native modules, the config plugins, the app
 * config and eas.json. An update reaches only the apps whose fingerprint is the same as its own.
 *
 * Two parts of the app config change with every release and change nothing native, so they are left out. With them
 * in, an update could never reach an app built from an earlier release, which is what updates are for.
 *
 * - `extra`: the OpenBot release the app names on every request (`openbotRelease`).
 * - the versions: the store version, and the build numbers.
 *
 * The third is Expo's own default, kept because a list here replaces the default.
 *
 * @type {import('@expo/fingerprint').Config}
 */
module.exports = {
  sourceSkips: [
    "ExpoConfigExtraSection",
    "ExpoConfigVersions",
    "PackageJsonAndroidAndIosScriptsIfNotContainRun",
  ],
};
