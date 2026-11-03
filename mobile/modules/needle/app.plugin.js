// Puts Needle's model inside the phone app, so it works offline from the first run.
// The file comes from `npm run get-needle` (modules/needle/README.md), which is run once on a PC
// before building. Without it the app still builds; the Phone Bot screen then says Needle is missing.
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withAppBuildGradle } = require("expo/config-plugins");

const WEIGHTS = path.join(__dirname, "assets", "needle3.cact");

module.exports = function withNeedle(config) {
  config = withDangerousMod(config, [
    "android",
    async (inner) => {
      if (fs.existsSync(WEIGHTS)) {
        const assets = path.join(
          inner.modRequest.platformProjectRoot,
          "app",
          "src",
          "main",
          "assets",
        );
        fs.mkdirSync(assets, { recursive: true });
        fs.copyFileSync(WEIGHTS, path.join(assets, "needle3.cact"));
      }
      return inner;
    },
  ]);
  return withAppBuildGradle(config, (inner) => {
    if (!inner.modResults.contents.includes('noCompress += ["cact"]')) {
      inner.modResults.contents = inner.modResults.contents.replace(
        /android\s*\{/,
        'android {\n    androidResources { noCompress += ["cact"] }',
      );
    }
    return inner;
  });
};
