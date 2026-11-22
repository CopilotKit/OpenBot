/*
 * The second module of the app frame, after clockBoot.ts and before the app's own entry. It sets
 * up the fakes of this frame: the user agent, still motion, the theme, the native side, the fake
 * `/api`, the AG-UI streams, the sockets, the Desktop page scripts and the scene's run.
 * It does not set `__workbenchBooted`: appBoot.ts does, after the app's entry drew its first element.
 * Pattern: desktop/workbench/frameBoot.ts. The page plays the clock; this frame never does.
 */

import { DESKTOP_PAGE_SCRIPTS } from "virtual:workbench-desktop-pages";
import { MotionGlobalConfig } from "motion/react";
import { nativeControl } from "../../desktop/src/fakeNative/control";
import { installPageShell } from "../../desktop/src/fakeNative/pageShell";
import type { ApiRoute, AppScene } from "../../desktop/workbench/appContract";
import type { RunAction } from "../../desktop/workbench/domSteps";
import {
  MAC_USER_AGENT,
  WINDOWS_USER_AGENT,
} from "../../desktop/workbench/frameConfig";
import { forceTheme, watchTheme } from "../../desktop/workbench/frameTheme";
import { getListBotsResponseMock } from "../src/lib/api/generated/bots/bots.msw";
import { createAgentStreams } from "./api/agentStream";
import { extraHandlers } from "./api/extraHandlers";
import { installFakeApi } from "./api/fakeApi";
import { generatedHandlers } from "./api/handlers";
import { navigateIn, startAppRun } from "./appRunner";
import { pageFallback } from "./pageDefaults";
import { APP_SCENES } from "./scenes";
import { sessionApi } from "./session";
import { installFakeSockets } from "./socket";

declare global {
  var __workbenchRunInfo:
    | { end: number; nextAt(ms: number): number | null }
    | undefined;
  var __workbenchBooted: boolean | undefined;
  /** The parent page listens here for each click and type step of the run. */
  var __workbenchActions:
    | { subscribe(listener: (action: RunAction) => void): () => void }
    | undefined;
}

/** preboot.js sets this on the frame: it moves its matchMedia to the new theme. */
type PrebootWindow = Window & {
  __workbenchPrebootTheme?: (theme: "light" | "dark") => void;
};

// These two run on `load`, as Desktop runs them on PageLoadEvent::Finished. The others run once
// the document is parsed.
const ON_LOAD = new Set(["APP_THEME_PAGE", "OVERLAY_TITLE_BAR_PAGE"]);

const STILL_CSS =
  "*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; }";

function message(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function runPageScript(script: { name: string; code: string }): void {
  try {
    // Desktop puts these scripts into the page as text, so the frame runs them as text too. An
    // indirect eval runs them in the global scope, as Desktop does.
    // biome-ignore lint/complexity/noCommaOperator: the indirect eval needs `(0, eval)`.
    // biome-ignore lint/security/noGlobalEval: the scripts come from the Desktop's Rust source.
    (0, eval)(script.code);
  } catch (error) {
    console.error(
      `Workbench: the desktop page script ${script.name} failed.`,
      error,
    );
  }
}

function whenParsed(run: () => void): void {
  if (document.readyState !== "loading") run();
  else document.addEventListener("DOMContentLoaded", run, { once: true });
}

function whenLoaded(run: () => void): void {
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
}

function boot(): void {
  // 1. The frame config and the scene.
  const config =
    window.parent !== window ? window.parent.__workbenchAppFrame : undefined;
  const scene: AppScene | undefined = APP_SCENES.find(
    (one) => one.id === config?.scene,
  );
  if (config === undefined || scene === undefined) {
    console.error(
      "Workbench: this frame has no workbench page or no scene around it.",
    );
    globalThis.__workbenchRunInfo = { end: 0, nextAt: () => null };
    globalThis.__workbenchBooted = true;
    return;
  }

  // 2. The page clock (clockBoot.ts) and the error list.
  const clock = globalThis.__workbenchClock;
  if (clock === undefined) {
    throw new Error(
      "Workbench: the page clock is missing. clockBoot.ts must run first.",
    );
  }
  const errors: string[] = [];
  window.__workbenchErrors = errors;
  window.addEventListener("error", (event) => {
    errors.push(event.error ? message(event.error) : event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    errors.push(message(event.reason));
  });

  // 3. The user agent of the scene's OS.
  const windows = config.os === "windows";
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => (windows ? WINDOWS_USER_AGENT : MAC_USER_AGENT),
  });

  // 4. Still motion: Motion skips its animations, and CSS has no transitions.
  if (config.motion === "still") {
    MotionGlobalConfig.skipAnimations = true;
    const style = document.createElement("style");
    style.dataset.workbenchStill = "";
    style.textContent = STILL_CSS;
    document.head.append(style);
  }

  // 5. The theme. A theme change from the page also moves preboot.js's matchMedia.
  forceTheme(document, config.theme);
  watchTheme(document);
  const setTheme = globalThis.__workbenchSetTheme;
  globalThis.__workbenchSetTheme = (theme) => {
    setTheme?.(theme);
    (window as PrebootWindow).__workbenchPrebootTheme?.(theme);
  };

  // 6. The native side.
  const control = nativeControl();
  if (config.host === "desktop") {
    installPageShell(window as { __TAURI_INTERNALS__?: unknown });
    control.setFallback(pageFallback());
  }
  for (const [name, answer] of Object.entries(scene.start.answers ?? {})) {
    control.setAnswer(name, answer);
  }
  for (const [name, answer] of Object.entries(config.answers)) {
    control.setAnswer(name, answer);
  }

  // 7. The sockets, the streams and the fake `/api`.
  const sockets = installFakeSockets(window);
  const streams = createAgentStreams();
  const agents: readonly string[] =
    scene.start.agents ?? getListBotsResponseMock().bots.map((bot) => bot.id);
  const api = installFakeApi(window, {
    origin: location.origin,
    realFetch: window.fetch.bind(window),
    groups: [
      { source: "stream", handlers: streams.handlers },
      { source: "extra", handlers: extraHandlers({ agents: () => agents }) },
      { source: "spec", handlers: generatedHandlers() },
    ],
    setTimer: (run, ms) => {
      window.setTimeout(run, ms);
    },
    now: () => clock.now(),
  });
  for (const answers of [
    sessionApi(scene.start.session, config.role),
    scene.start.api ?? {},
    config.api,
  ]) {
    for (const [route, answer] of Object.entries(answers)) {
      if (answer !== undefined) api.setAnswer(route as ApiRoute, answer);
    }
  }
  window.__workbenchApi = api;
  window.__workbenchStreams = streams;
  window.__workbenchSockets = sockets;

  // 8. The scripts Desktop runs in the app's page.
  if (config.host === "desktop") {
    const scripts = DESKTOP_PAGE_SCRIPTS.filter(
      (script) => script.os === "any" || script.os === config.os,
    );
    whenParsed(() => {
      for (const script of scripts) {
        if (!ON_LOAD.has(script.name)) runPageScript(script);
      }
    });
    whenLoaded(() => {
      for (const script of scripts) {
        if (ON_LOAD.has(script.name)) runPageScript(script);
      }
    });
  }

  // 9. The run. The page plays the clock and listens for each click and type step.
  const actionListeners = new Set<(action: RunAction) => void>();
  globalThis.__workbenchActions = {
    subscribe(listener) {
      actionListeners.add(listener);
      return () => {
        actionListeners.delete(listener);
      };
    },
  };
  globalThis.__workbenchRunInfo = startAppRun(
    scene.run ?? [],
    clock,
    {
      control,
      api,
      streams,
      sockets,
      root: document,
      navigate: (path) => navigateIn(window, path),
    },
    {
      onAction(action) {
        for (const listener of [...actionListeners]) {
          try {
            listener(action);
          } catch (error) {
            console.error(error);
          }
        }
      },
    },
  );
}

boot();
