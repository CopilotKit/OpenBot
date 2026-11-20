import { z } from "zod";

/**
 * WHAT OPENBOT'S OWN PAGE MAY ASK THE RECORDER IN THE SAME BROWSER, over `externally_connectable` (`openbot.ping` and
 * `openbot.connect` are older and unchanged). When OpenBot is open in a browser that holds the Recorder, its Browser
 * button works with that browser: Record and Stop from OpenBot, and the red dot read straight from the Recorder.
 *
 * Only the OpenBot the Recorder is connected to may use these: the Recorder compares the origin Chrome reports for the
 * sender with its stored connection's, and answers any other page as not connected, telling it nothing about the
 * person or what they record. Design: Notion "OpenBot Browser: BUILD (2026-10-21)".
 */
export const RECORDER_PAGE_MESSAGES = {
  /** What the Recorder is doing, for this OpenBot: `RecorderPageState`. */
  state: "openbot.state",
  /** Start recording `title`, from the tab that asked; the recording follows every tab the person uses. `narrate` is the
   * person's narration choice as OpenBot keeps it on their account; absent, the choice they made in the Recorder. */
  record: "openbot.record",
  /** Stop the live recording. */
  stop: "openbot.stop",
} as const;

export const recorderPageMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(RECORDER_PAGE_MESSAGES.state) }).strict(),
  z
    .object({
      type: z.literal(RECORDER_PAGE_MESSAGES.record),
      title: z.string().trim().min(1).max(200),
      narrate: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal(RECORDER_PAGE_MESSAGES.stop) }).strict(),
]);
export type RecorderPageMessage = z.infer<typeof recorderPageMessageSchema>;

/** `connected: false` for any page that is not the connected OpenBot, with nothing else in it. */
export type RecorderPageState =
  | { connected: false }
  | {
      connected: true;
      phase: "idle" | "starting" | "recording" | "stopping";
      title?: string;
      startedAt?: number;
      actions: number;
      /** The recording Stop ended last, as the launcher reports it (shared/openbot-browser.ts `LauncherState`). */
      lastStopped?: {
        recordingId: string;
        title: string;
        stoppedAt: number;
        actions: number;
        phrases: number;
      };
    };

/** Every answer to `record` and `stop`; a refusal carries the Recorder's own sentence. */
export type RecorderPageResult =
  | { ok: true; state: RecorderPageState }
  | { ok: false; error: string };

/**
 * Where a connect a page asked for has got to (`openbot.connect.status`), asked while it waits for the person on the
 * Recorder's Connect page, so it can say at once that they cancelled or closed that tab rather than wait out the five
 * minutes a request lasts. Any page may ask, as any page may ask to connect, and the answer is only ever about the
 * connect from the origin that asks: nothing about this copy, its connection, or another site's request.
 * - `waiting`: the Connect page for it is open, and the person has not chosen.
 * - `cancelled`: the person pressed Cancel there.
 * - `closed`: the person closed that tab without choosing.
 * - `none`: nothing is waiting for this origin (it connected, another site's request took its place, or it never asked).
 */
export const RECORDER_CONNECT_STATUS = "openbot.connect.status";
export type RecorderConnectWait = "waiting" | "cancelled" | "closed" | "none";

/**
 * Which `openbot.connect` requests the Recorder accepts with no Connect page (David, 2026-10-22: "only for trusted
 * OpenBots"): an origin the organization's policy pins (`OpenBotUrl`), or OpenBot Desktop's own loopback address on this
 * computer, exactly as OpenBot Desktop's native host confirms it (any program can serve a page on a loopback port), and
 * either only while the Recorder is connected to nothing: replacing a connection always goes through the Connect page.
 * Every other site still gets the one Connect click, so no site can quietly take the Recorder for itself.
 */
export type TrustedConnectRule = "policy-pinned" | "loopback-desktop";
