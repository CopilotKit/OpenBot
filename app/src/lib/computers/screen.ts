import { tryClient } from "@/lib/client";
import type { ComputerState } from "./queries";

/**
 * One frame of a Bot's screen.
 *
 * Not a cached read. Frames are polled while somebody is watching and are stale the moment after
 * they arrive, so holding one in a query cache would mean serving a picture of a screen that has
 * since moved.
 */
export type Screenshot = {
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /** `about:blank` when the browser has not been sent anywhere yet. Absent on older computers. */
  url?: string;
};

/**
 * What a screenshot request can come back with.
 *
 * `notReady` is not an error. The server answers it for a computer that is asleep or starting, and
 * does so without waking it; a computer in either state is behaving normally, so the caller draws it
 * calmly and keeps polling. `error` is a screenshot that was attempted and failed.
 */
export type ScreenshotRead = {
  frame?: Screenshot;
  error?: string;
  notReady?: { state: ComputerState; reason?: string };
};

const COMPUTER_STATES: readonly ComputerState[] = [
  "absent",
  "starting",
  "ready",
  "unreachable",
];

/**
 * Read the current frame.
 *
 * Fails closed, and says why: the screen going unavailable is something the person watching needs
 * told, and it is not a reason to tear down the panel they are watching it in. The caller decides
 * whether to keep polling.
 */
export async function readScreenshot(
  computerId: string,
): Promise<ScreenshotRead> {
  const unavailable = "The screen is not available right now.";
  try {
    const response = await tryClient(`/api/computers/${computerId}/screenshot`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return { error: body?.error ?? unavailable };
    }
    const body = (await response.json().catch(() => null)) as unknown;
    const notReady = notReadyOf(body);
    if (notReady) return { notReady };
    return parseScreenshot(body);
  } catch {
    return { error: unavailable };
  }
}

/**
 * Say the Bot's screen was opened, which starts a computer that is off.
 *
 * The reads above never start one: a conversation makes them too, and a computer that started for
 * every look would never stay off. Opening the screen is a person asking to see the computer, so
 * that is said on its own. The server answers at once with the computer's state (`starting` for one
 * it has just started) and does not wait for it to come up.
 *
 * Fails closed: nothing when the server could not be asked or has no such route, and the screen then
 * says the computer is off, which it is.
 */
export async function startComputer(
  computerId: string,
): Promise<ComputerState | null> {
  try {
    const response = await tryClient(
      `/api/computers/${encodeURIComponent(computerId)}/wake`,
      { method: "POST" },
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      state?: unknown;
    } | null;
    return COMPUTER_STATES.includes(body?.state as ComputerState)
      ? (body?.state as ComputerState)
      : null;
  } catch {
    return null;
  }
}

/** The server's "not ready yet" answer, or nothing when the body is something else. */
function notReadyOf(body: unknown): ScreenshotRead["notReady"] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const { ready, state, reason } = body as {
    ready?: unknown;
    state?: unknown;
    reason?: unknown;
  };
  if (ready !== false) return;
  if (!COMPUTER_STATES.includes(state as ComputerState)) return;
  return {
    state: state as ComputerState,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function parseScreenshot(body: unknown): {
  frame?: Screenshot;
  error?: string;
} {
  const unavailable = "The screen is not available right now.";
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: unavailable };
  }
  const frame = (body as { frame?: unknown }).frame ?? body;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return { error: unavailable };
  }
  const { base64, width, height } = frame as {
    base64?: unknown;
    width?: unknown;
    height?: unknown;
  };
  // A mistyped frame used to reach `atob` in the viewer and throw there. Refused here instead.
  if (
    typeof base64 !== "string" ||
    !base64 ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return { error: unavailable };
  }
  return { frame: frame as Screenshot };
}

/** The frame a page was showing when a Bot opened it. */
export type PageFrame = { url: string; title: string | null; frame: string };

/**
 * What this turn had on screen when it opened its page, or nothing if it was never kept.
 *
 * Nothing here writes. The frame is taken on the server at the moment the navigation succeeds, which
 * is the only moment the screen is certainly showing the page that was asked for. Capturing it here
 * instead meant capturing it after the turn, from a computer other conversations are also driving,
 * and filing whatever it happened to show.
 */
export async function readPageFrame(
  computerId: string,
  toolCallId: string,
): Promise<PageFrame | null> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/page-frame/${encodeURIComponent(toolCallId)}`,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const frame = (body as { frame?: unknown }).frame;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      return null;
    }
    const { frame: image } = frame as { frame?: unknown };
    if (typeof image !== "string" || !image) return null;
    return frame as PageFrame;
  } catch {
    // A missing picture is a smaller sentence, not a broken conversation.
    return null;
  }
}
