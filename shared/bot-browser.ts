import { z } from "zod";
import {
  type BrowserNarrationRequest,
  type BrowserTab,
  browserOpenRequestSchema,
  type LauncherState,
} from "./openbot-browser";

/*
 * A BOT'S BROWSER, WORKED BY A PERSON: the bar above a Bot's screen (tabs, the address, back, forward and reload) and
 * the Recorder, which is loaded into every Bot's browser and records only while a person holds control.
 *
 * ONLY THE PERSON IS RECORDED, NEVER THE BOT. A recording starts only while a person holds the wheel, and only for that
 * person (`ComputerControlState.heldBy`). The computer ends it the moment the wheel leaves them: they hand it back, the
 * Bot's request is completed or cancelled, the browser restarts, the computer stops. While a person holds the wheel the
 * Bot cannot act, so every step recorded is the person's.
 *
 * THE RECORDER IS SILENT UNTIL RECORD. Loaded at every launch of a Bot's browser (bundled Chromium: `--load-extension`
 * with `--disable-extensions-except`, as the hosted person's browser loads it), never connected until a recording starts,
 * and disconnected again when it ends. It injects nothing into a page while it is not recording.
 *
 * THE CONNECTION IS THE RECORDING PERSON'S, FOR ONE RECORDING. The server mints a Recorder connection (`via`
 * `bot-browser`) for the person who pressed Record and hands it over with the start; Stop ends the recording, the
 * computer disconnects the Recorder, and the server revokes the connection. A connection left by a recording the
 * computer ended on its own is revoked the next time the server reads that Bot's browser or mints another for it. The
 * recording lands where every Recorder recording lands: the person's own Learning space.
 *
 * NARRATION is the OpenBot page's own speech recognition (`external`), posted to the server and corrected to its clock,
 * exactly as for the hosted person's browser.
 */

/* WHO HOLDS THE WHEEL. `POST /control/take` on the computer takes `{ requestId, by }`, `by` the signed-in person's user
 * id, which the server always sends; the computer keeps it as `heldBy` on the stored control and reports it on
 * `ComputerControlState.heldBy` while `holder` is `human`, and clears it when the wheel goes back. A control state from
 * before this change, or a take with no `by`, has no `heldBy`: nobody may record or use the bar until it is taken again. */

/* THE COMPUTER'S ROUTES (agent-computer), under the computer token like every other route, with the Bot's id in
 * `x-openbot-bot-id`. A person's browser id (`person-…`) is refused with 400: the person's own browser has its own routes
 * (`browserComputerPaths`). A computer Bots share refuses that id sooner, with 503, since no person's browser runs there
 * at all (agent-computer's person-access.ts). Every route answers `BotBrowserState`, or `{ error }` with a status below. */
export const botBrowserComputerPaths = {
  /** GET: the Bot's browser as it is. Never launches it. */
  state: "/bot-browser/state",
  /** POST `BrowserTabsRequest`. 409 unless a person holds the wheel. */
  tabs: "/bot-browser/tabs",
  /** POST `BrowserNavigateRequest`. 409 unless a person holds the wheel. */
  navigate: "/bot-browser/navigate",
  /** POST `BotBrowserComputerRecordingRequest`. A start is 409 unless `by` holds the wheel. */
  recording: "/bot-browser/recording",
  /** POST `BrowserNarrationRequest`, on the server's clock. 409 unless a recording is running. */
  narration: "/bot-browser/narration",
  /**
   * POST `BotBrowserComputerClearRequest`: wipe the Bot's browser (see CLEARING A BROWSER below) and start it again,
   * fresh. 409 unless `by` holds the wheel. Answers the fresh browser's `BotBrowserState`.
   */
  clear: "/bot-browser/clear",
} as const;

/*
 * CLEARING A BROWSER: what a person does when its data has gone wrong, for a Bot's browser (only by the person holding
 * its wheel, so it is never wiped under the Bot mid-task) and for the person's own (`browserComputerPaths.clear`).
 *
 * The whole profile goes: cookies, cache, saved passwords, history, site storage, and the Recorder's own storage. A
 * recording running there ends first, and what it has not sent yet is waited for. The computer closes the browser,
 * deletes its user data directory, and forgets the page it described; the server forgets the snapshots and the
 * screenshots it kept of its pages. Nothing else on the computer goes (a Bot's files stay), and nor do OpenBot's
 * Passwords, which are OpenBot's and never were the browser's. A person holding a Bot's wheel keeps it: the browser
 * starts again under them.
 *
 * Deleted while closed, rather than cleared through DevTools (`Storage.clearDataForOrigin`, `Network.clearBrowserCookies`),
 * which clear one origin's site storage or every cookie but not history, saved passwords or an extension's own storage,
 * and so leave a browser partly what it was.
 */
export const botBrowserComputerClearRequestSchema = z
  .object({
    /** The person who pressed Clear; must be `heldBy`. */
    by: z.string().min(1).max(200),
  })
  .strict();
export type BotBrowserComputerClearRequest = z.infer<
  typeof botBrowserComputerClearRequestSchema
>;

/** What the server sends the computer: the app's request, plus who pressed Record and their connection. */
export const botBrowserComputerRecordingRequestSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("start"),
        title: z.string().trim().min(1).max(200),
        language: z.string().max(35).optional(),
        /** The person who pressed Record; must be `heldBy`. */
        by: z.string().min(1).max(200),
        /**
         * The Recorder connection the server minted for `by`, exactly as the person's own browser is handed one, and
         * always: a person's browser may keep the connection it holds across opens, but a Bot's is connected for one
         * person's one recording, and disconnected when it ends.
         */
        connection: browserOpenRequestSchema.shape.connection.unwrap(),
      })
      .strict(),
    z.object({ action: z.literal("stop") }).strict(),
  ],
);
export type BotBrowserComputerRecordingRequest = z.infer<
  typeof botBrowserComputerRecordingRequestSchema
>;
export type BotBrowserState = {
  /** Whether the Bot's browser is running. A closed one has no tabs and no Recorder report. */
  open: boolean;
  tabs: BrowserTab[];
  /** The Recorder's own report from inside the Bot's browser; absent while the browser is closed or it has not answered. */
  recorder?: LauncherState;
  /** The person a running recording belongs to. */
  recordingBy?: string;
  /**
   * The person the recording `recorder.lastStopped` names belonged to, so OpenBot tells them, and only them, that it went
   * to their Learning space, after a reload as well. Absent while there is no `lastStopped`.
   */
  lastStoppedBy?: string;
};

/* THE SERVER'S ROUTES, for a person who may use the Bot (`canUseBot`). The app calls these; the server checks the caller
 * holds the wheel where a route says so, mints and revokes the Recorder connection, and forwards to the computer routes
 * above. A person who may not use the Bot gets 404, as for every route under a Bot. */
export const botBrowserApiPaths = {
  /** GET: `BotBrowserApiState`. */
  state: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser`,
  /** POST `BrowserTabsRequest`: answers `BotBrowserApiState`. 409 unless the caller holds the wheel. */
  tabs: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/tabs`,
  /** POST `BrowserNavigateRequest`: answers `BotBrowserApiState`. 409 unless the caller holds the wheel. */
  navigate: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/navigate`,
  /** POST `BrowserRecordingRequest`: answers `BotBrowserApiState`. A start is 409 unless the caller holds the wheel,
   * and 403 where Bots share one computer (`recordRefused`); a stop is 409 unless the recording is the caller's. */
  recording: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/recording`,
  /** POST `BrowserNarrationRequest`. 409 unless the running recording is the caller's. */
  narration: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/narration`,
  /** POST, no body: clear the Bot's browser (CLEARING A BROWSER, above). Answers `BotBrowserApiState`, the fresh
   * browser. 409 unless the caller holds the wheel. Audited as `computer.browser_cleared`. */
  clear: (botId: string) =>
    `/api/computers/${encodeURIComponent(botId)}/browser/clear`,
} as const;

export type BotBrowserApiState = BotBrowserState & {
  /** Whether the signed-in person holds the wheel, so the bar and Record are live for them. */
  mine: boolean;
  /** Whether the running recording, if any, is the signed-in person's. Another person's shows only that one is running. */
  recordingIsMine: boolean;
  /**
   * Why Record cannot run in this Bot's browser here, said in place of Record: its Bots share one computer, where any
   * other Bot could read the person's Recorder connection off the disk. Absent where Record can run.
   */
  recordRefused?: string;
};

/** The narration route's body is the person's browser's, unchanged. */
export type BotBrowserNarrationRequest = BrowserNarrationRequest;

/** The `via` a Bot's browser's Recorder connection is minted with (`recorder_connections.via`). */
export const BOT_BROWSER_VIA = "bot-browser";
