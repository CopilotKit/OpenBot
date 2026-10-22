import { useCallback, useEffect, useState } from "react";

/**
 * The OpenBot Desktop shell's "Open Intelligence dashboard", reached from this page.
 *
 * Not a server request: inside Desktop the page is loaded in the shell's own window, and the shell
 * lets exactly this app's origin call two commands of one plugin (`openbot-intelligence`), `watch`
 * and `open`. In a plain browser there is no shell, and in Desktop without a local Intelligence
 * stack the shell says `unavailable`; either way the row is not drawn.
 *
 * What the shell tells the page is only a state and, for a failure, a fixed category. The words are
 * chosen here.
 */
export type DashboardFailure =
  | "not_set_up"
  | "not_responding"
  | "browser_failed"
  | "busy"
  | "engine_stopped"
  | "unsupported"
  | "timed_out"
  | "stopped"
  | "failed";

export type DashboardOffer =
  | { state: "unavailable" | "ready" | "opening" }
  | { state: "failed"; reason: DashboardFailure };

const FAILURES: Record<DashboardFailure, string> = {
  not_set_up: "Set up local Intelligence before opening it.",
  not_responding: "Intelligence is not responding yet. Try again shortly.",
  browser_failed: "Your browser did not open. Try again.",
  busy: "Another Intelligence command is running. Try again when it finishes.",
  engine_stopped: "The software Intelligence runs on is not running.",
  unsupported: "This version of OpenBot cannot open Intelligence.",
  timed_out: "Intelligence took too long to open. Try again.",
  stopped: "Opening Intelligence was stopped.",
  failed: "OpenBot could not open Intelligence. Try again.",
};

export function dashboardFailureSaid(reason: DashboardFailure): string {
  return FAILURES[reason];
}

/** The part of Tauri's injected IPC this page uses. Present only inside the Desktop window. */
export type ShellIpc = {
  transformCallback: (callback: (message: unknown) => void) => number;
  unregisterCallback?: (id: number) => void;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export function desktopShell(): ShellIpc | null {
  if (typeof window === "undefined") return null;
  const internals = (window as { __TAURI_INTERNALS__?: Partial<ShellIpc> })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" &&
    typeof internals.transformCallback === "function"
    ? (internals as ShellIpc)
    : null;
}

const WATCH = "plugin:openbot-intelligence|watch";
const OPEN = "plugin:openbot-intelligence|open";

/** A message from the shell, or null for anything that is not exactly one of the known shapes. */
export function readOffer(message: unknown): DashboardOffer | null {
  if (!message || typeof message !== "object") return null;
  const { state, reason } = message as { state?: unknown; reason?: unknown };
  if (state === "unavailable" || state === "ready" || state === "opening")
    return { state };
  if (state === "failed")
    return {
      state,
      reason:
        typeof reason === "string" && reason in FAILURES
          ? (reason as DashboardFailure)
          : "failed",
    };
  return null;
}

/**
 * Hand the shell a channel and call `onOffer` with each thing it says, in order. Returns the
 * cleanup. A shell that refuses (another origin, an older Desktop) reads as `unavailable`.
 */
export function watchDashboard(
  shell: ShellIpc,
  onOffer: (offer: DashboardOffer) => void,
): () => void {
  let active = true;
  // Tauri numbers a channel's messages; one that arrives late is older than what is shown.
  let next = 0;
  const id = shell.transformCallback((raw) => {
    if (!active || !raw || typeof raw !== "object" || !("message" in raw))
      return;
    const index = (raw as { index?: unknown }).index;
    if (typeof index === "number") {
      if (index < next) return;
      next = index + 1;
    }
    const offer = readOffer((raw as { message: unknown }).message);
    if (offer) onOffer(offer);
  });
  shell.invoke(WATCH, { onOffer: `__CHANNEL__:${id}` }).catch(() => {
    if (active) onOffer({ state: "unavailable" });
  });
  return () => {
    active = false;
    shell.unregisterCallback?.(id);
  };
}

/** How long a failure stays under the row. */
const FAILURE_SHOWN_FOR_MS = 8_000;

export type IntelligenceDashboard = {
  /** Draw the row at all. */
  available: boolean;
  opening: boolean;
  /** A short sentence about the last opening that failed, while it is shown. */
  failure: string | null;
  open: () => void;
};

/**
 * The sidebar row's state, from the same in-flight state as Desktop's menu: an opening started
 * from the menu spins here too.
 */
export function useIntelligenceDashboard(
  shell: ShellIpc | null = desktopShell(),
): IntelligenceDashboard {
  const [offer, setOffer] = useState<DashboardOffer>({ state: "unavailable" });
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!shell) return;
    return watchDashboard(shell, (next) => {
      if (next.state === "failed") {
        setFailure(dashboardFailureSaid(next.reason));
        setOffer({ state: "ready" });
        return;
      }
      if (next.state === "opening") setFailure(null);
      setOffer(next);
    });
  }, [shell]);

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), FAILURE_SHOWN_FOR_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  const open = useCallback(() => {
    if (!shell) return;
    // Said at once; the shell's own `opening` follows, then how it went.
    setFailure(null);
    setOffer({ state: "opening" });
    shell.invoke(OPEN).catch(() => {
      setFailure(dashboardFailureSaid("failed"));
      setOffer({ state: "ready" });
    });
  }, [shell]);

  return {
    available: shell !== null && offer.state !== "unavailable",
    opening: offer.state === "opening",
    failure,
    open,
  };
}
