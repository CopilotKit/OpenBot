// Runs before the window's own entry: it sets up the fake native side for this frame.
import { nativeControl } from "../src/fakeNative/control";
import { installStates } from "../src/fakeNative/states";
import {
  MAC_USER_AGENT,
  readFrameConfig,
  WINDOWS_ANSWERS,
  WINDOWS_USER_AGENT,
} from "./frameConfig";
import { forceTheme, watchTheme } from "./frameTheme";
declare global {
  var __workbenchBooted: boolean | undefined;
}

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

const root = document.getElementById("root");
if (!root || root.childElementCount > 0) globalThis.__workbenchBooted = true;
else {
  const observer = new MutationObserver(() => {
    if (root.childElementCount > 0) {
      observer.disconnect();
      globalThis.__workbenchBooted = true;
    }
  });
  observer.observe(root, { childList: true });
}
