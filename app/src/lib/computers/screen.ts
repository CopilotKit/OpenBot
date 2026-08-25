import { tryClient } from "@/lib/client";

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
 * Read the current frame.
 *
 * Fails closed, and says why: the screen going unavailable is something the person watching needs
 * told, and it is not a reason to tear down the panel they are watching it in. The caller decides
 * whether to keep polling.
 */
export async function readScreenshot(
  computerId: string,
): Promise<{ frame?: Screenshot; error?: string }> {
  const unavailable = "The screen is not available right now.";
  try {
    const response = await tryClient(`/api/computers/${computerId}/screenshot`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return { error: body?.error ?? unavailable };
    }
    return { frame: (await response.json()) as Screenshot };
  } catch {
    return { error: unavailable };
  }
}

/** The frame a page was showing when a Bot opened it. */
export type PageFrame = { url: string; title: string | null; frame: string };

/**
 * What that page looked like when this turn opened it, or nothing if it was never kept.
 *
 * Nothing here writes. The frame is taken on the server at the moment the navigation succeeds, which
 * is the only moment the screen is certainly showing the page that was asked for. Capturing it here
 * instead meant capturing it after the turn, from a computer other conversations are also driving,
 * and filing whatever it happened to show.
 */
export async function readPageFrame(
  computerId: string,
  url: string,
): Promise<PageFrame | null> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/page-frame?url=${encodeURIComponent(url)}`,
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { frame?: PageFrame | null };
    return body.frame ?? null;
  } catch {
    // A missing picture is a smaller sentence, not a broken conversation.
    return null;
  }
}
