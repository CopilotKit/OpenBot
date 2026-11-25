// Installs the fake native/API boundaries before the real app entry. Browser timers stay intact.
import { DESKTOP_PAGE_SCRIPTS } from "virtual:workbench-desktop-pages";
import { nativeControl } from "../../desktop/src/fakeNative/control";
import { installPageShell } from "../../desktop/src/fakeNative/pageShell";
import type {
  ApiControl,
  ApiRoute,
  AppScene,
} from "../../desktop/workbench/appContract";
import {
  MAC_USER_AGENT,
  WINDOWS_USER_AGENT,
} from "../../desktop/workbench/frameConfig";
import { forceTheme, watchTheme } from "../../desktop/workbench/frameTheme";
import { getListBotsResponseMock } from "../src/lib/api/generated/bots/bots.msw";
import { createAgentStreams } from "./api/agentStream";
import { agentsForBots, BOTS_ROUTE, extraHandlers } from "./api/extraHandlers";
import { installFakeApi } from "./api/fakeApi";
import { generatedHandlers } from "./api/handlers";
import { pageFallback } from "./pageDefaults";
import { APP_SCENES } from "./scenes";
import { sessionApi } from "./session";
import { skinApi } from "./skins";
import { installFakeSockets } from "./socket";

declare global {
  var __workbenchBooted: boolean | undefined;
}

/** preboot.js sets this on the frame: it moves its matchMedia to the new theme. */
type PrebootWindow = Window & {
  __workbenchPrebootTheme?: (theme: "light" | "dark") => void;
};

// These two run on `load`, as Desktop runs them on PageLoadEvent::Finished. The others run once
// the document is parsed.
const ON_LOAD = new Set(["APP_THEME_PAGE", "OVERLAY_TITLE_BAR_PAGE"]);

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
    globalThis.__workbenchBooted = true;
    return;
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
  const bots = getListBotsResponseMock();
  const organization = scene.start.session.signedIn
    ? scene.start.session.organization.id
    : "default";
  const botsPath = `/api/v2/organizations/${organization}/bots`;
  const api: ApiControl = installFakeApi(window, {
    origin: location.origin,
    realFetch: window.fetch.bind(window),
    groups: [
      { source: "stream", handlers: streams.handlers },
      {
        source: "extra",
        handlers: extraHandlers({
          agents: () => scene.start.agents ?? agentsForBots(api, botsPath),
        }),
      },
      { source: "spec", handlers: generatedHandlers() },
    ],
    setTimer: (run, ms) => {
      window.setTimeout(run, ms);
    },
    now: () => performance.now(),
  });
  for (const answers of [
    { [BOTS_ROUTE]: { mode: "value" as const, body: bots } },
    sessionApi(scene.start.session, config.role),
    scene.start.api ?? {},
    skinApi(config.skin),
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
}

boot();
