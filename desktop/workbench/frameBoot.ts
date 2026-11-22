// Runs before the window's own entry: it sets up the fake native side for this frame.
import { nativeControl } from "../src/fakeNative/control";
import { installStates } from "../src/fakeNative/states";
import { installClock, type PageClock, SCENE_EPOCH } from "./clock";
import {
  MAC_USER_AGENT,
  readFrameConfig,
  WINDOWS_ANSWERS,
  WINDOWS_USER_AGENT,
} from "./frameConfig";
import { forceTheme, watchTheme } from "./frameTheme";
import { startRun } from "./runner";
import type { RunStep } from "./scenes/types";

declare global {
  var __workbenchClock: PageClock | undefined;
  var __workbenchRunInfo:
    | { end: number; nextAt(ms: number): number | null }
    | undefined;
  var __workbenchBooted: boolean | undefined;
  interface Window {
    __workbenchRun?: RunStep[];
  }
}

// The page clock goes in first, so every later timer and Date read goes through it.
const clock = installClock(SCENE_EPOCH);
globalThis.__workbenchClock = clock;

const config = readFrameConfig();
const control = nativeControl();
const windows = config.os === "windows";

Object.defineProperty(navigator, "userAgent", {
  configurable: true,
  get: () => (windows ? WINDOWS_USER_AGENT : MAC_USER_AGENT),
});

globalThis.__workbenchEnv = config.env;
installStates();

if (windows) {
  for (const [name, answer] of Object.entries(WINDOWS_ANSWERS)) {
    control.setAnswer(name, answer);
  }
}
for (const [name, answer] of Object.entries(config.answers)) {
  control.setAnswer(name, answer);
}

forceTheme(document, config.theme);
watchTheme(document);

// The parent page may give a run. Without one, the window runs as in real time.
const steps =
  window.parent !== window ? window.parent.__workbenchRun : undefined;
const run = startRun(steps ?? [], clock);
globalThis.__workbenchRunInfo = run;
if (steps === undefined) clock.play(1);

globalThis.__workbenchBooted = true;
