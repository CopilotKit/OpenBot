/**
 * The full Linux desktop a person watches and drives.
 *
 * The desktop is an RFB framebuffer produced by x11vnc and translated to WebSocket by websockify.
 * It is deliberately separate from the CDP page cast: CDP can only show a page viewport, while the
 * framebuffer includes Chromium's address bar, tabs, browser dialogs, the desktop panel and any
 * other application running on the Bot's computer.
 */

export type DesktopMode = "view" | "control";

export type DesktopCapability = {
  available: boolean;
  protocol: "rfb";
  width: number;
  height: number;
};

/** The image opts in explicitly after its display, VNC servers and WebSocket bridges are running. */
export function desktopCapability(
  environment: Record<string, string | undefined> = process.env,
): DesktopCapability {
  const width = positiveInteger(environment.DESKTOP_WIDTH, 1280);
  const height = positiveInteger(environment.DESKTOP_HEIGHT, 800);
  return {
    available:
      environment.COMPUTER_DESKTOP === "on" && Boolean(environment.DISPLAY),
    protocol: "rfb",
    width,
    height,
  };
}

/** Only the named control mode may ever reach the writable VNC server. */
export function desktopMode(value: string | null): DesktopMode {
  return value === "control" ? "control" : "view";
}

/**
 * Both servers are loopback-only. The read-only server is a real server-side boundary, not a UI
 * preference: a modified noVNC client connected while watching still cannot inject input.
 */
export function desktopUpstream(
  mode: DesktopMode,
  environment: Record<string, string | undefined> = process.env,
): string {
  if (mode === "control") {
    return environment.DESKTOP_CONTROL_URL?.trim() || "ws://127.0.0.1:6081";
  }
  return environment.DESKTOP_VIEW_URL?.trim() || "ws://127.0.0.1:6080";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
