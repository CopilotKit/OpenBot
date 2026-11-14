/** The part of Tauri's injected IPC this page uses. Present only inside the Desktop window. */
export type ShellIpc = {
  transformCallback: (callback: (message: unknown) => void) => number;
  unregisterCallback?: (id: number) => void;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/** The OpenBot Desktop window this page is loaded in, or null in a plain browser. */
export function desktopShell(): ShellIpc | null {
  if (typeof window === "undefined") return null;
  const internals = (window as { __TAURI_INTERNALS__?: Partial<ShellIpc> })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" &&
    typeof internals.transformCallback === "function"
    ? (internals as ShellIpc)
    : null;
}
