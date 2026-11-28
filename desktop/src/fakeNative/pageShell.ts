/*
 * The Desktop window's `__TAURI_INTERNALS__`, as the OpenBot app sees it, on top of the shared
 * native control. The app reads only `invoke`, `transformCallback` and `unregisterCallback`
 * (app/src/lib/desktop/shell.ts), so this adapter gives only those three.
 */
import { callNative } from "./control";

export type PageShell = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  transformCallback(
    callback: (message: unknown) => void,
    once?: boolean,
  ): number;
  unregisterCallback(id: number): void;
};

type Registered = { callback: (message: unknown) => void; once: boolean };

/** Puts a page shell on `target.__TAURI_INTERNALS__`. */
export function installPageShell(target: { __TAURI_INTERNALS__?: unknown }): {
  shell: PageShell;
  /** Calls the callback with this id at once. False when no callback has this id. */
  deliver(id: number, message: unknown): boolean;
  /** Takes the shell off the target. */
  remove(): void;
} {
  const callbacks = new Map<number, Registered>();
  let nextId = 1;

  const shell: PageShell = {
    invoke: (command, args) => callNative(command, args),
    transformCallback(callback, once = false) {
      const id = nextId++;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
  };
  target.__TAURI_INTERNALS__ = shell;

  return {
    shell,
    deliver(id, message) {
      const registered = callbacks.get(id);
      if (registered === undefined) return false;
      if (registered.once) callbacks.delete(id);
      registered.callback(message);
      return true;
    },
    remove() {
      delete target.__TAURI_INTERNALS__;
    },
  };
}
