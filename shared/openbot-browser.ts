import { z } from "zod";

/**
 * THE OPENBOT BROWSER: a real browser a person opens from OpenBot and uses as their own, with the OpenBot Recorder
 * already in it and already connected. This file is the contract between the four places that build it: the computer
 * that launches the browser (`agent-computer`), the server that opens it for a signed-in person, the Recorder that
 * records in it, and the app's Browser page. Design: Notion "OpenBot Browser: BUILD (2026-10-21)".
 *
 * One browser per person. It is a computer named for that person, so every way of reaching a computer that gives it a
 * computer of its own (a supervisor container, a Kubernetes Sandbox, or the host-side local Chrome computer on OpenBot
 * Desktop) carries it unchanged: the id goes in `x-openbot-bot-id` as a Bot's does. Never the one computer every Bot
 * shares: a Bot there runs a shell beside the browser's profile, and the profile holds what the person signed in to by
 * hand. The server refuses it there, and so does the computer (`PEOPLE_ONLY_ENV`, `COMPUTER_BOT_ID`).
 */
export const PERSON_BROWSER_PREFIX = "person-";

/** A person's browser id: the prefix and 32 lowercase hex digits the server derives from the OpenBot user id. */
const PERSON_BROWSER_ID = /^person-[0-9a-f]{32}$/;

export function isPersonBrowserId(id: string): boolean {
  return PERSON_BROWSER_ID.test(id);
}

/**
 * Where the browser shows. `native`: a window on the person's own desktop (OpenBot Desktop, the person's installed
 * Chrome or Edge). `screen`: a cloud browser the app shows through the live screen (hosted OpenBot, bundled Chromium).
 */
export type BrowserWindow = "native" | "screen";
/** The person's own everyday browsers OpenBot Desktop can put the Recorder in and bring forward. */
export type RealBrowser = "chrome" | "msedge";
export type BrowserProduct = "chrome" | "msedge" | "chromium";

/**
 * Who hears the person. `own`: the Recorder transcribes the person's microphone itself, as it does in any browser
 * (native). `external`: the browser has no microphone (screen), so the app transcribes the person in their own browser
 * and each final phrase reaches the Recorder through `narrate`.
 */
export type Narration = "own" | "external";

/* THE RECORDER'S LAUNCHER API.
 *
 * What the process that launched the browser, and alone holds its DevTools pipe, calls inside the Recorder's service
 * worker as `globalThis[LAUNCHER_GLOBAL]`. No web page and no other extension can reach it: there is no message route
 * to it from outside the Recorder. Every method resolves; a refusal is `{ ok: false, error }`, never a throw. */
export const LAUNCHER_GLOBAL = "openbotLauncher";

export type LauncherConnection = {
  /** The OpenBot this browser belongs to: an https origin, or http on a loopback IP with a port (OpenBot Desktop). */
  openbotUrl: string;
  /** A Recorder bearer (`obr_…`) the server minted for this person and this browser. */
  token: string;
  connectionId: string;
  user: { id: string; name: string; email: string };
};

export type LauncherState = {
  connected: boolean;
  /** The connected person, when there is one. */
  userId?: string;
  /**
   * The connection it holds (`LauncherConnection.connectionId`), when there is one: OpenBot keeps a connection that
   * stands for this browser rather than making another each time the browser is opened.
   */
  connectionId?: string;
  phase: "idle" | "starting" | "recording" | "stopping";
  recordingId?: string;
  title?: string;
  startedAt?: number;
  /** The person's actions so far in this recording, as the Recorder's badge counts them. */
  actions: number;
  narration: Narration;
  /**
   * Whether the Recorder is hearing the person itself, for narration `own`: `listening` while a recording runs and the
   * microphone is live, `muted` when the person muted it, `unavailable` when it cannot hear (no permission, no device,
   * the recogniser failed), `off` when nothing is being recorded. Absent for narration `external`.
   */
  voice?: "off" | "listening" | "muted" | "unavailable";
  /**
   * The recording Stop ended last, so OpenBot can confirm it went to the person's Learning space: how many of the
   * person's actions it held (as the badge counted them) and how many narrated phrases. Both 0: nothing was recorded.
   */
  lastStopped?: {
    recordingId: string;
    title: string;
    stoppedAt: number;
    actions: number;
    phrases: number;
    /**
     * True while some of this recording is still on its way to Intelligence after Stop. Absent once all of it is sent,
     * or once what is left is kept for later (held by Intelligence's refusal, or waiting for its person to connect this
     * browser again) or discarded. Whoever disconnects the Recorder after a Stop waits for it, because a disconnect
     * keeps what is not sent yet for the person's next connection here instead of sending it now.
     */
    sending?: boolean;
  };
};

export type LauncherResult<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export type LauncherApi = {
  /** Store this connection (replacing any other) and take narration from `narration`. Idempotent. */
  connect(input: {
    connection: LauncherConnection;
    narration: Narration;
  }): Promise<LauncherResult>;
  /** Start recording the tab the person is on (or `tabId`), named `title`; or stop the live recording. */
  record(
    input:
      | {
          action: "start";
          title: string;
          tabId?: number;
          language?: string;
          narrate?: boolean;
        }
      | { action: "stop" },
  ): Promise<LauncherResult<{ state: LauncherState }>>;
  /** One final phrase the app heard, with when the person started and stopped saying it (epoch ms). */
  narrate(input: {
    text: string;
    startedAt: number;
    endedAt: number;
  }): Promise<LauncherResult>;
  /**
   * The app heard the person start a phrase at `since` (epoch ms), or stop speaking (`null`). While a phrase is being
   * spoken the Recorder holds the steps taken from `since` on until that phrase's `narrate` arrives (at most 15 s), as
   * it does for its own recogniser, so a phrase is placed before the steps it was spoken over.
   */
  speaking(input: { since: number | null }): Promise<LauncherResult>;
  /**
   * OpenBot revoked this browser's connection (the person disconnected it in Settings, Browsers): forget it now and
   * report signed out, as the Recorder does when OpenBot answers that its token is gone. A recording in progress ends
   * the way a sign-out ends one. Idempotent.
   */
  disconnect(): Promise<LauncherResult>;
  state(): Promise<LauncherState>;
};

/* THE COMPUTER'S ROUTES (agent-computer), under the computer token like every other route, with the person's browser
 * id in `x-openbot-bot-id`. A non-person id is refused with 400. */
export const browserComputerPaths = {
  open: "/browser/open",
  state: "/browser/state",
  recording: "/browser/recording",
  narration: "/browser/narration",
  /** POST, no body: the Recorder forgets its connection now (`LauncherApi.disconnect`). Answers `BrowserState`. */
  disconnect: "/browser/disconnect",
  tabs: "/browser/tabs",
  navigate: "/browser/navigate",
  close: "/browser/close",
  /**
   * POST, no body: wipe the person's browser, open or closed, as a Bot's is wiped (`shared/bot-browser.ts`, CLEARING A
   * BROWSER), and leave it closed: only the server can hand its Recorder a connection again. Answers `BrowserState`.
   */
  clear: "/browser/clear",
} as const;

/**
 * An open. With `connection`, the Recorder is handed it. Without one, the browser opens (or comes forward) and its
 * Recorder keeps the connection it holds, which the answer's `recorder` names: OpenBot opens it so when it holds a
 * connection that stands for this browser, and hands it a new one only when the Recorder turns out not to hold that
 * one. Minting one at every open revoked the last each time, and wrote a `recorder.revoked` and a `recorder.connected`
 * row for every visit to the Browser page.
 */
export const browserOpenRequestSchema = z
  .object({
    connection: z
      .object({
        openbotUrl: z.string().url().max(2000),
        token: z.string().min(1).max(200),
        connectionId: z.string().min(1).max(200),
        user: z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().max(200),
            email: z.string().max(320),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserOpenRequest = z.infer<typeof browserOpenRequestSchema>;

export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  active: boolean;
};

export type BrowserState = {
  open: boolean;
  browser?: BrowserProduct;
  window?: BrowserWindow;
  /** The Recorder's own report; absent while the browser is closed or the Recorder has not answered yet. */
  recorder?: LauncherState;
  tabs: BrowserTab[];
};

export const browserRecordingRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      title: z.string().trim().min(1).max(200),
      language: z.string().max(35).optional(),
      /** Whether the person narrates this recording, as OpenBot's Record form asked them: the Recorder opens the
       * microphone only when it is true. Absent: the choice made in the Recorder itself, and none is no. */
      narrate: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("stop") }).strict(),
]);
export type BrowserRecordingRequest = z.infer<
  typeof browserRecordingRequestSchema
>;

/**
 * A final phrase, or the person starting (`speaking: true`) or stopping (`speaking: false`) a phrase. `sentAt` is the
 * sender's clock when it sent this: the page's times come from the person's computer, so the server shifts every time by
 * (its own clock on arrival minus `sentAt`) before forwarding, and the Recorder sees them on the server's clock, which is
 * the clock its steps are on. The computer receives the corrected times and a `sentAt` of the server's own clock.
 */
const epochMs = z.number().int().positive();
export const browserNarrationRequestSchema = z.union([
  z
    .object({
      text: z.string().trim().min(1).max(4000),
      startedAt: epochMs,
      endedAt: epochMs,
      sentAt: epochMs,
    })
    .strict(),
  z
    .object({ speaking: z.literal(true), since: epochMs, sentAt: epochMs })
    .strict(),
  z.object({ speaking: z.literal(false), sentAt: epochMs }).strict(),
]);
export type BrowserNarrationRequest = z.infer<
  typeof browserNarrationRequestSchema
>;

export const browserTabsRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("new"), url: z.string().max(2000).optional() })
    .strict(),
  z
    .object({ action: z.literal("activate"), tabId: z.string().min(1) })
    .strict(),
  z.object({ action: z.literal("close"), tabId: z.string().min(1) }).strict(),
]);
export type BrowserTabsRequest = z.infer<typeof browserTabsRequestSchema>;

export const browserNavigateRequestSchema = z.union([
  z.object({ url: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ action: z.enum(["back", "forward", "reload"]) }).strict(),
]);
export type BrowserNavigateRequest = z.infer<
  typeof browserNavigateRequestSchema
>;

/* THE SERVER'S ROUTES, for the signed-in person's own browser only. The app calls these; the server finds the person's
 * browser, mints its Recorder connection, and forwards to the computer routes above. */
export const browserApiPaths = {
  /** POST: open (or bring forward) the person's browser. Answers `BrowserOpenResponse`. */
  open: "/api/browser/open",
  /** GET: `BrowserApiState`. */
  state: "/api/browser",
  /** POST `BrowserRecordingRequest`: answers `BrowserApiState`. */
  recording: "/api/browser/recording",
  /** POST `BrowserNarrationRequest`. */
  narration: "/api/browser/narration",
  /** POST `BrowserTabsRequest`: answers `BrowserApiState`. */
  tabs: "/api/browser/tabs",
  /** POST `BrowserNavigateRequest`: answers `BrowserApiState`. */
  navigate: "/api/browser/navigate",
  /** POST: close the person's browser. */
  close: "/api/browser/close",
  /**
   * POST, no body: clear the person's browser (`shared/bot-browser.ts`, CLEARING A BROWSER). One that was open opens
   * again, fresh. Answers `BrowserApiState`. Audited as `computer.browser_cleared`.
   */
  clear: "/api/browser/clear",
} as const;

/* THE PERSON'S REAL BROWSER (OpenBot Desktop). Where the person's own everyday Chrome or Edge can hold the Recorder,
 * the Browser button works with that browser instead of a separate one: OpenBot Desktop registers the Recorder with it
 * (from the store), the Recorder connects through OpenBot Desktop's native host with no Connect page, and the host-side
 * computer brings that browser forward, or opens the Recorder's store page in it while the Recorder is not there yet.
 * These computer routes act on the person's desktop and exist only on the local Chrome backend. */
export const realBrowserComputerPaths = {
  /** GET: `{ browsers: RealBrowser[] }`, the person's own browsers installed on this computer. Never launches one. */
  installed: "/browser/real",
  /** POST `{ browser }`: bring the person's own browser forward (launching it if it is not running). */
  front: "/browser/real/front",
  /** POST `{ browser, url }`: open `url` (the Recorder's store page) in the person's own browser, not the default one. */
  store: "/browser/real/store",
} as const;

export const realBrowserRequestSchema = z
  .object({
    browser: z.enum(["chrome", "msedge"]),
    url: z.string().url().max(2000).optional(),
  })
  .strict();
export type RealBrowserRequest = z.infer<typeof realBrowserRequestSchema>;

/** What `POST /api/browser/open` did on OpenBot Desktop when the person's own browser is the Browser button's. */
export type RealBrowserOpenResponse = {
  ok: true;
  /** `real`: brought their browser forward, its Recorder connected. `store`: opened the Recorder's store page in it. */
  opened: "real" | "store";
  browser: RealBrowser;
};

export type BrowserOpenResponse = {
  ok: true;
  /** The computer id of the person's browser: the live screen streams `/api/computers/<computerId>/stream`. */
  computerId: string;
  browser: BrowserProduct;
  window: BrowserWindow;
  narration: Narration;
};

export type BrowserApiState = BrowserState & {
  /**
   * On OpenBot Desktop: the person's own browsers installed on this computer, and whether a Recorder in one of them is
   * connected to this OpenBot as this person (a live connection made through OpenBot Desktop). Absent elsewhere.
   */
  real?: { connected: boolean; browsers: RealBrowser[] };
  /** What the person's own Recorders are doing, wherever they record (the newest live report): the red dot. */
  activity?: import("./recorder-api").RecorderActivity;
  /** False when this OpenBot has no way to run a person's browser; the app then hides the Browser button. */
  available: boolean;
  /**
   * Why the person's browser is not the one they would expect, in one plain sentence for them: why this OpenBot cannot
   * run one at all (with `available` false), or, on OpenBot Desktop, why it is not their own installed Chrome or Edge.
   * Absent when there is nothing to explain.
   */
  note?: string;
  /**
   * The person's browser is there and is not answering, said for them in one plain sentence: nothing of it can be shown
   * until it answers again. Absent while it answers.
   */
  problem?: string;
  /**
   * Where this OpenBot shows the person's browser, known before it is opened, so the sidebar's Browser button knows
   * what one click does: `native` opens (or brings forward) a window on the person's desktop and leaves them where
   * they are; `screen` takes them to the browser in the page. Present whenever `available` is.
   */
  shows?: BrowserWindow;
  computerId: string;
  narration?: Narration;
};

/* CONFIGURATION, by name. */
/** On the computer: the built Recorder (`extension/dist`), absolute. Without it `/browser/open` refuses. */
export const RECORDER_DIR_ENV = "OPENBOT_RECORDER_DIR";
/** On the server: the computer that runs people's browsers here, when it is not the Bots' computer (OpenBot Desktop's
 * host-side local Chrome computer, `http://127.0.0.1:4101`). Unset: the normal computer provider locates it. */
export const BROWSER_URL_ENV = "OPENBOT_BROWSER_URL";
/**
 * On the computer: `on` when it runs people's own browsers and nothing else (OpenBot Desktop's host-side local Chrome
 * computer). Such a computer refuses every Bot, and a computer without it runs a person's browser only when it was
 * started for that one browser (`COMPUTER_BOT_ID` names it: a supervisor's container, a Sandbox).
 */
export const PEOPLE_ONLY_ENV = "COMPUTER_PEOPLE_ONLY";
/**
 * On the server: why OpenBot Desktop runs no browser of the person's own on this machine, as one of
 * {@link BROWSER_ABSENCES}' names. Desktop writes it at every Start where it found none, and takes it out where it
 * found one. The server tells the person in the sentence beside it.
 */
export const BROWSER_ABSENT_ENV = "OPENBOT_BROWSER_ABSENT";
/** Each reason OpenBot Desktop can give, and what the person is told. */
export const BROWSER_ABSENCES = {
  "no-chrome-or-edge":
    "OpenBot can't find Google Chrome or Microsoft Edge on this computer, so it can't open your own browser.",
  "flatpak-chrome":
    "OpenBot can't open the Flatpak version of Google Chrome, so install Chrome from google.com/chrome to use your own browser.",
  "flatpak-edge":
    "OpenBot can't open the Flatpak version of Microsoft Edge, so install Edge from microsoft.com/edge to use your own browser.",
  "recorder-not-built":
    "Your own browser isn't set up yet, so quit OpenBot and open it again.",
  "no-home-folder":
    "OpenBot can't find your home folder, so it has nowhere to keep your own browser's profile.",
} satisfies Record<string, string>;
export type BrowserAbsence = keyof typeof BROWSER_ABSENCES;

export function isBrowserAbsence(value: string): value is BrowserAbsence {
  return Object.hasOwn(BROWSER_ABSENCES, value);
}
