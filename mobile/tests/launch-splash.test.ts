/**
 * The phone's splash and the app's launch cover (src/launch.tsx) draw the same frame, so the one hands over to the
 * other without a jump: the same orb at the same width, on the screen's own background in light and in dark.
 */
import { expect, test } from "bun:test";
import config, { SPLASH } from "../app.config";
import { LAUNCH_ORB_SIZE } from "../src/launch-orb";
import { scheme } from "../src/scheme";

test("the splash is drawn on the scheme's background, light and dark", () => {
  expect(SPLASH.light).toBe(scheme.light.background);
  expect(SPLASH.dark).toBe(scheme.dark.background);
});

test("the splash's orb is as wide as the launch cover's", () => {
  expect(SPLASH.orbWidth).toBe(LAUNCH_ORB_SIZE);
});

test("the splash plugin is given those values", () => {
  const splash = config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
  ) as [string, Record<string, unknown>] | undefined;
  expect(splash?.[1]).toMatchObject({
    image: "./assets/orb.png",
    imageWidth: LAUNCH_ORB_SIZE,
    backgroundColor: scheme.light.background,
    dark: {
      image: "./assets/orb.png",
      backgroundColor: scheme.dark.background,
    },
  });
});
