import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserAction,
  BrowserComputer,
  BrowserElement,
  BrowserManager,
  BrowserSnapshot,
  HumanAction,
} from "./browser";
import { StaleSnapshotError } from "./browser";
import type { InputMessage } from "./screencast";

type CuaToolResult = {
  text: string;
  images: { mimeType: string; dataBase64: string }[];
  structuredJson?: string;
  isError: boolean;
  errorCode?: string;
  rawJson: string;
};

export type CuaDriver = {
  callTool(
    name: string,
    argumentsJson: string,
    options?: { signal: AbortSignal },
  ): Promise<CuaToolResult>;
  shutdown(): Promise<void>;
  uniffiDestroy?: () => void;
};

type BrowserState = {
  session: string;
  pid: number;
  windowId: number;
  targetId: string;
  tabId: string;
  url: string;
  title: string;
  snapshotId: number;
  startedAt: string;
  lastRead?: {
    text: string;
    truncated: boolean;
  };
};

type Structured = Record<string, unknown>;

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TEXT_EXTRACT_LIMIT = 6000;
const SNAPSHOT_ELEMENT_LIMIT = 200;
const STALE_CODES = new Set(["browser_binding_stale", "browser_ref_stale"]);

const CUA_KEY_NAMES: Record<string, string> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Esc: "escape",
  Meta: "super",
  PageDown: "pagedown",
  PageUp: "pageup",
  " ": "space",
  Spacebar: "space",
};

function cuaKeyName(key: string): string {
  return CUA_KEY_NAMES[key] ?? key.toLowerCase();
}

function structured(result: CuaToolResult): Structured {
  if (!result.structuredJson) return {};
  try {
    return JSON.parse(result.structuredJson) as Structured;
  } catch {
    return {};
  }
}

function field(value: unknown): Structured {
  return value !== null && typeof value === "object"
    ? (value as Structured)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function staleMessage(expected: number, current: number): string {
  return `That list of elements is out of date: it was taken for snapshot ${expected} and the page is now at ${current}. Take a new snapshot and use the refs from it.`;
}

export function createCuaBrowserManager(
  root: string,
  driver: CuaDriver,
  browserExecutable: string,
  options: {
    seedPid?: () => Promise<{ pid: number; close: () => Promise<void> }>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): BrowserManager {
  const states = new Map<string, BrowserState>();
  const starting = new Map<string, Promise<BrowserState>>();
  const computers = new Map<string, BrowserComputer>();

  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ result: CuaToolResult; data: Structured }> => {
    const result = await driver.callTool(
      name,
      JSON.stringify(args),
      signal ? { signal } : undefined,
    );
    const data = structured(result);
    if (result.isError) {
      const refusal = field(data.refusal);
      const code =
        result.errorCode ?? string(refusal.code) ?? string(data.code) ?? "";
      const message = result.text || `Cua Driver ${name} failed.`;
      if (
        STALE_CODES.has(code) ||
        /\bbrowser_(?:binding|ref)_stale\b/.test(message)
      ) {
        throw new StaleSnapshotError(message);
      }
      throw new Error(message);
    }
    return { result, data };
  };

  const pause = options.sleep ?? sleep;
  const launchSeed = async (): Promise<{
    pid: number;
    close: () => Promise<void>;
  }> => {
    const profile = await mkdtemp(join(tmpdir(), "openbot-cua-seed-"));
    const process = Bun.spawn({
      cmd: [
        browserExecutable,
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await pause(100);
    return {
      pid: process.pid,
      async close() {
        process.kill();
        await process.exited.catch(() => undefined);
        await rm(profile, { recursive: true, force: true });
      },
    };
  };

  const windowFor = async (pid: number): Promise<number> => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const { data } = await call("list_windows", {
        pid,
        on_screen_only: true,
      });
      const windows = list(data.windows)
        .map(field)
        .filter((window) => number(window.window_id) !== undefined)
        .sort(
          (left, right) =>
            (number(right.z_index) ?? Number.NEGATIVE_INFINITY) -
            (number(left.z_index) ?? Number.NEGATIVE_INFINITY),
        );
      const selected = windows[0];
      if (selected) return number(selected.window_id) as number;
      await pause(100);
    }
    throw new Error(
      "Cua Driver launched Chromium but no browser window appeared.",
    );
  };

  const start = async (botId: string): Promise<BrowserState> => {
    if (!PROFILE_NAME.test(botId)) {
      throw new Error(
        "A Cua Driver computer id may contain only letters, digits, hyphen and underscore, start with a letter or digit, and be at most 64 characters.",
      );
    }
    const session = `openbot-${botId}`;
    try {
      await call("start_session", { session });
      const seed = await (options.seedPid ?? launchSeed)();
      let prepared: Structured;
      try {
        ({ data: prepared } = await call("browser_prepare", {
          pid: seed.pid,
          allow_launch: true,
          profile: { mode: "isolated_named", name: botId },
          session,
        }));
      } finally {
        await seed.close();
      }

      const pid = number(prepared.prepared_pid);
      if (!pid) {
        throw new Error(
          "Cua Driver did not report the prepared browser process.",
        );
      }
      const windowId = await windowFor(pid);
      const { data: bound } = await call("get_browser_state", {
        pid,
        window_id: windowId,
        session,
      });
      if (
        bound.binding_quality !== "exact" ||
        bound.mutation_allowed !== true
      ) {
        throw new Error(
          "Cua Driver could not bind the isolated browser exactly.",
        );
      }
      const targetId = string(bound.target_id);
      const tabs = list(bound.tabs).map(field);
      const selected =
        tabs.find((tab) => tab.active === true) ??
        tabs.find((tab) => tab.url === "about:blank") ??
        tabs[0];
      const tabId = string(selected?.tab_id);
      if (!targetId || !tabId) {
        throw new Error("Cua Driver did not return a browser target and tab.");
      }
      const state: BrowserState = {
        session,
        pid,
        windowId,
        targetId,
        tabId,
        url: string(selected?.url) ?? "about:blank",
        title: string(selected?.title) ?? "",
        snapshotId: 0,
        startedAt: new Date().toISOString(),
      };
      states.set(botId, state);
      return state;
    } catch (error) {
      await call("end_session", { session }).catch(() => undefined);
      throw error;
    }
  };

  const ensure = async (botId: string): Promise<BrowserState> => {
    const existing = states.get(botId);
    if (existing) {
      // Explicit sessions expire after five idle minutes. Starting the same name refreshes or
      // revives it; checking the exact native window detects the managed browser cleanup that an
      // expiry performs, so the next request can reopen the durable profile instead of pinning this
      // process to a dead pid.
      await call("start_session", { session: existing.session });
      const alive = await call("list_windows", {
        pid: existing.pid,
        on_screen_only: false,
      })
        .then(({ data }) =>
          list(data.windows)
            .map(field)
            .some((window) => number(window.window_id) === existing.windowId),
        )
        .catch(() => false);
      if (alive) {
        return existing;
      }
      await call("end_session", { session: existing.session }).catch(
        () => undefined,
      );
      states.delete(botId);
    }
    const pending = starting.get(botId);
    if (pending) return pending;
    const created = start(botId);
    starting.set(botId, created);
    try {
      return await created;
    } finally {
      starting.delete(botId);
    }
  };

  const refreshBinding = async (state: BrowserState): Promise<void> => {
    const previousUrl = state.url;
    const { data } = await call("get_browser_state", {
      pid: state.pid,
      window_id: state.windowId,
      session: state.session,
    });
    if (data.binding_quality !== "exact" || data.mutation_allowed !== true) {
      throw new Error(
        "Cua Driver could not refresh the isolated browser binding.",
      );
    }
    const tabs = list(data.tabs).map(field);
    const selected =
      tabs.find((tab) => tab.tab_id === state.tabId) ??
      tabs.find((tab) => tab.active === true) ??
      tabs[0];
    const targetId = string(data.target_id);
    const tabId = string(selected?.tab_id);
    if (!targetId || !tabId) {
      throw new Error("Cua Driver did not return a browser target and tab.");
    }
    state.targetId = targetId;
    state.tabId = tabId;
    state.url = string(selected?.url) ?? state.url;
    state.title = string(selected?.title) ?? state.title;
    if (state.url !== previousUrl) state.lastRead = undefined;
  };

  const observe = async (
    state: BrowserState,
  ): Promise<{
    elements: BrowserElement[];
    text: string;
    truncated: boolean;
  }> => {
    await refreshBinding(state);
    const { data } = await call("get_browser_state", {
      target_id: state.targetId,
      tab_id: state.tabId,
      session: state.session,
      snapshot_format: "semantic_v2",
      include_screenshot: false,
    });
    const page = field(data.page);
    state.url = string(page.url) ?? state.url;
    const observedTitle = string(page.title);
    if (
      observedTitle !== undefined &&
      !(observedTitle === "about:blank" && state.url !== "about:blank")
    ) {
      state.title = observedTitle;
    }
    state.snapshotId += 1;
    const actionable = list(data.refs)
      .map(field)
      .filter((ref) => {
        const actions = list(ref.actions);
        return (
          Boolean(string(ref.ref)) &&
          (actions.includes("click") || actions.includes("type"))
        );
      });
    const elements = actionable.slice(0, SNAPSHOT_ELEMENT_LIMIT).map((ref) => {
      const states = field(ref.states);
      const role = string(ref.role) ?? "unknown";
      const checked = boolean(states.checked);
      return {
        ref: string(ref.ref) as string,
        role,
        name: (string(ref.name) ?? "").slice(0, 200),
        ...(string(ref.value) !== undefined
          ? { value: (string(ref.value) as string).slice(0, 200) }
          : {}),
        ...(string(states.type) !== undefined
          ? { type: string(states.type) }
          : {}),
        ...(boolean(states.disabled) !== undefined
          ? { disabled: boolean(states.disabled) }
          : {}),
        ...(checked !== undefined ? { checked } : {}),
      } satisfies BrowserElement;
    });
    const outline = string(data.outline) ?? "";
    const snapshot = field(data.snapshot);
    const observed = {
      elements,
      text: outline.slice(0, TEXT_EXTRACT_LIMIT),
      truncated:
        outline.length > TEXT_EXTRACT_LIMIT ||
        actionable.length > SNAPSHOT_ELEMENT_LIMIT ||
        snapshot.complete === false ||
        string(snapshot.continuation) !== undefined,
    };
    state.lastRead = {
      text: observed.text,
      truncated: observed.truncated,
    };
    return observed;
  };

  const assertSnapshot = (state: BrowserState, expected?: number) => {
    if (expected !== undefined && expected !== state.snapshotId) {
      throw new StaleSnapshotError(staleMessage(expected, state.snapshotId));
    }
  };

  const windowTarget = (state: BrowserState) => ({
    kind: "window",
    pid: state.pid,
    window_id: state.windowId,
  });

  const currentUrl = (state: BrowserState): string => state.url;

  const nativeKey = async (
    state: BrowserState,
    key: string,
    signal?: AbortSignal,
  ) => {
    await call(
      "press_key",
      {
        key: cuaKeyName(key),
        target: windowTarget(state),
        session: state.session,
        delivery_mode: "foreground",
      },
      signal,
    );
  };

  const captureWindow = async (state: BrowserState) => {
    const { result, data } = await call("get_window_state", {
      pid: state.pid,
      window_id: state.windowId,
      session: state.session,
    });
    const image = result.images[0];
    if (!image) throw new Error("Cua Driver returned no window screenshot.");
    return {
      base64: image.dataBase64,
      width: number(data.screenshot_width) ?? 0,
      height: number(data.screenshot_height) ?? 0,
      capturedAt: new Date().toISOString(),
      url: currentUrl(state),
    };
  };

  const build = (botId: string): BrowserComputer => {
    const computer: BrowserComputer = {
      async navigate(url, signal) {
        const state = await ensure(botId);
        await call(
          "browser_navigate",
          {
            target_id: state.targetId,
            tab_id: state.tabId,
            url,
            session: state.session,
          },
          signal,
        );
        state.url = url;
        const observed = await observe(state);
        return {
          url: state.url,
          title: state.title,
          text: observed.text,
          truncated: observed.truncated,
        };
      },

      async read() {
        const state = await ensure(botId);
        await refreshBinding(state);
        const observed = state.lastRead ?? (await observe(state));
        return {
          url: state.url,
          title: state.title,
          text: observed.text,
          truncated: observed.truncated,
        };
      },

      async screenshot() {
        return captureWindow(await ensure(botId));
      },

      async snapshot(): Promise<BrowserSnapshot> {
        const state = await ensure(botId);
        const observed = await observe(state);
        return {
          snapshotId: state.snapshotId,
          url: state.url,
          title: state.title,
          elements: observed.elements,
          truncated: observed.truncated,
        };
      },

      async click(ref, expected, signal): Promise<BrowserAction> {
        const state = await ensure(botId);
        assertSnapshot(state, expected);
        await call(
          "browser_click",
          {
            target_id: state.targetId,
            tab_id: state.tabId,
            ref,
            input_route: "dom_event",
            session: state.session,
          },
          signal,
        );
        state.lastRead = undefined;
        return { action: "click", ref, url: currentUrl(state) };
      },

      async type(ref, text, submit, expected, signal): Promise<BrowserAction> {
        const state = await ensure(botId);
        assertSnapshot(state, expected);
        await call(
          "browser_type",
          {
            target_id: state.targetId,
            tab_id: state.tabId,
            ref,
            text: submit ? `${text}\n` : text,
            replace: true,
            ...(submit ? { mode: "keystrokes" } : {}),
            session: state.session,
          },
          signal,
        );
        state.lastRead = undefined;
        return {
          action: "type",
          ref,
          characters: text.length,
          submitted: submit,
          url: currentUrl(state),
        };
      },

      async key(key, ref, expected, signal): Promise<BrowserAction> {
        const state = await ensure(botId);
        assertSnapshot(state, expected);
        if (ref) {
          const refText =
            key === "Enter" ? "\n" : key.length === 1 ? key : null;
          if (refText === null) {
            throw new Error(
              "Cua Driver supports ref-scoped key presses only for Enter and printable characters; omit the ref for native keys such as arrows or Backspace.",
            );
          }
          await call(
            "browser_type",
            {
              target_id: state.targetId,
              tab_id: state.tabId,
              ref,
              text: refText,
              mode: "keystrokes",
              session: state.session,
            },
            signal,
          );
        } else {
          await nativeKey(state, key, signal);
        }
        state.lastRead = undefined;
        return { action: "key", key, ref, url: currentUrl(state) };
      },

      async scroll(deltaY, signal): Promise<BrowserAction> {
        const state = await ensure(botId);
        const shot = await captureWindow(state);
        await call(
          "scroll",
          {
            x: shot.width / 2,
            y: shot.height / 2,
            direction: deltaY < 0 ? "up" : "down",
            by: "line",
            amount: Math.max(1, Math.round(Math.abs(deltaY) / 100)),
            target: windowTarget(state),
            session: state.session,
            delivery_mode: "foreground",
          },
          signal,
        );
        state.lastRead = undefined;
        return { action: "scroll", deltaY, url: currentUrl(state) };
      },

      async enterSecret(ref, text) {
        const state = await ensure(botId);
        await call("browser_type", {
          target_id: state.targetId,
          tab_id: state.tabId,
          ref,
          text,
          replace: true,
          session: state.session,
        });
        state.lastRead = undefined;
        return { characters: text.length, url: currentUrl(state) };
      },

      async humanClick(x, y): Promise<HumanAction> {
        const state = await ensure(botId);
        const shot = await captureWindow(state);
        await call("click", {
          x: Math.min(Math.max(x, 0), Math.max(shot.width - 1, 0)),
          y: Math.min(Math.max(y, 0), Math.max(shot.height - 1, 0)),
          target: windowTarget(state),
          session: state.session,
          button: "left",
          count: 1,
          delivery_mode: "foreground",
        });
        state.lastRead = undefined;
        return { action: "human_click", url: currentUrl(state) };
      },

      async humanType(text): Promise<HumanAction> {
        const state = await ensure(botId);
        await call("type_text", {
          text,
          target: windowTarget(state),
          session: state.session,
          delivery_mode: "foreground",
        });
        state.lastRead = undefined;
        return {
          action: "human_type",
          characters: text.length,
          url: currentUrl(state),
        };
      },

      async humanKey(key): Promise<HumanAction> {
        const state = await ensure(botId);
        await nativeKey(state, key);
        state.lastRead = undefined;
        return { action: "human_key", key, url: currentUrl(state) };
      },

      async humanScroll(deltaY): Promise<HumanAction> {
        const state = await ensure(botId);
        const shot = await captureWindow(state);
        await call("scroll", {
          x: shot.width / 2,
          y: shot.height / 2,
          direction: deltaY < 0 ? "up" : "down",
          by: "line",
          amount: Math.max(1, Math.round(Math.abs(deltaY) / 100)),
          target: windowTarget(state),
          session: state.session,
          delivery_mode: "foreground",
        });
        state.lastRead = undefined;
        return { action: "human_scroll", deltaY, url: currentUrl(state) };
      },

      async startStream(onFrame) {
        let stopped = false;
        let previous = "";
        const loop = async () => {
          while (!stopped) {
            try {
              const shot = await captureWindow(await ensure(botId));
              if (shot.base64 !== previous) {
                previous = shot.base64;
                onFrame({
                  type: "frame",
                  data: shot.base64,
                  width: shot.width,
                  height: shot.height,
                  mimeType: "image/png",
                });
              }
            } catch {
              // A later iteration can recover after the browser starts or reconnects.
            }
            await pause(500);
          }
        };
        void loop();
        const send = async (message: InputMessage) => {
          if (message.type === "text") {
            await computer.humanType(message.text);
          } else if (message.type === "wheel") {
            await computer.humanScroll(message.deltaY);
          } else if (message.type === "key" && message.event === "down") {
            if (message.text) await computer.humanType(message.text);
            else await computer.humanKey(message.key);
          } else if (message.type === "mouse" && message.event === "released") {
            await computer.humanClick(message.x, message.y);
          }
        };
        return {
          async stop() {
            stopped = true;
          },
          send,
        };
      },
    };
    return computer;
  };

  return {
    backend: "cua-driver",
    computer(botId) {
      const existing = computers.get(botId);
      if (existing) return existing;
      const created = build(botId);
      computers.set(botId, created);
      return created;
    },
    async known() {
      const entries = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      return [
        ...new Set([
          ...entries
            .filter(
              (entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name),
            )
            .map((entry) => entry.name),
          ...states.keys(),
        ]),
      ].sort();
    },
    summary(botIds) {
      const known = new Set([...botIds, ...states.keys()]);
      return [...known].sort().map((botId) => {
        const live = states.get(botId);
        return {
          botId,
          running: Boolean(live),
          startedAt: live?.startedAt ?? null,
          egress: null,
        };
      });
    },
    async stop(botId) {
      const state = states.get(botId);
      if (!state) return false;
      await call("end_session", { session: state.session }).catch(
        () => undefined,
      );
      states.delete(botId);
      computers.delete(botId);
      return true;
    },
    async reset(botId) {
      const state = states.get(botId);
      if (state) {
        await call("end_session", { session: state.session }).catch(
          () => undefined,
        );
      }
      states.delete(botId);
      computers.delete(botId);
      if (!PROFILE_NAME.test(botId)) throw new Error("Invalid computer id.");
      await rm(join(root, botId), { recursive: true, force: true });
    },
    async closeAll() {
      await Promise.all(
        [...states.values()].map((state) =>
          call("end_session", { session: state.session }).catch(
            () => undefined,
          ),
        ),
      );
      states.clear();
      await driver.shutdown();
      driver.uniffiDestroy?.();
    },
  };
}
