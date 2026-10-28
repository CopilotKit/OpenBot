/**
 * The OpenBot Browser's routes on this computer: open a person's browser with the Recorder in it and
 * connected, and act for the person in it (record, narrate, tabs, navigate, close, clear).
 *
 * Under the computer token like every other route, with the person's browser id in
 * `x-openbot-bot-id`; `index.ts` checks the token, this checks the id. The server is the only caller:
 * it decides who the signed-in person is, mints their Recorder connection, and forwards here. The
 * shapes are the contract in `shared/openbot-browser.ts`, which every slice builds against.
 *
 * Every answer but narration's is the browser's state, so the caller never has to ask twice to show
 * what a change did.
 *
 * Its own module, taking the browsers it acts on, so a test can serve these exact routes over a
 * person's browser launched headless, which the computer's own environment refuses for a native one.
 */
import type { BrowserContext, Page } from "playwright";
import {
  type BrowserOpenRequest,
  type BrowserState,
  browserComputerPaths,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  isPersonBrowserId,
  type LauncherState,
  type Narration,
} from "../../shared/openbot-browser";
import { createTabBar } from "./browser-tabs";
import { BROWSER_NOT_OPEN, BrowserNotOpenError } from "./person-access";
import {
  NoInstalledBrowserError,
  PersonOpenError,
  type PersonOpenStep,
} from "./person-browser";
import type { OpenPersonBrowser, Profiles } from "./profiles";
import { findRecorder } from "./recorder";
import {
  RecorderUnavailableError,
  SENDING_WAIT_MS,
  untilSent,
} from "./recorder-launcher";

export type BrowserHostOptions = {
  profiles: Profiles;
  /** `OPENBOT_RECORDER_DIR`, read at every open so a rebuilt Recorder is the one the next browser gets. */
  recorderDir: () => string | undefined;
  navigationTimeoutMs: number;
  /**
   * Told while a person's browser is being cleared, once it has closed and before it can open again: the computer
   * forgets the browser it described (`profiles.clear`).
   */
  forget?: (botId: string) => void;
  /** How long a clear waits for a recording it stopped to reach Intelligence: `SENDING_WAIT_MS` unless a test's own. */
  sendingWaitMs?: number;
};

/** What the person is told when their browser did not open for a reason that is not the computer's setup: the reason
 * itself (often a page of Playwright's own text) goes to the computer's log. */
const NOT_OPENED = "Your browser could not be opened. Try again.";

/** How long one tab may take to say whether it is showing, before it is left out of the question. */
const VISIBILITY_MS = 1_000;

/**
 * How long the browser has to say what it is showing before the state route answers that it is not answering.
 *
 * A browser that answers at all answers this in milliseconds: the end-to-end run measured 2 to 19 ms. One whose main
 * thread is stuck never answers DevTools at all, and the route used to wait for it for as long as its caller did:
 * OpenBot gave up after 45 s, after its own server had already closed the person's request with an empty reply at 10.
 * The Browser page asks every second, and then had no browser to show and no sentence, and the sidebar lost its Browser
 * button. Bounded well under OpenBot's own wait for this route (server/src/browser/routes.ts, STATE_TIMEOUT_MS), so the
 * person hears it from here, where it is known that the browser is open and not answering.
 */
export const STATE_ANSWER_MS = 5_000;
/**
 * How long the state waits for the Recorder's own report. Within {@link STATE_ANSWER_MS}: a Recorder still starting, or
 * busy, is left out of the answer rather than making a browser that answers look like one that does not. The page asks
 * again a second later, and a Recorder that has started by then is in that answer.
 */
const RECORDER_REPORT_MS = 3_000;

/** What the state route answers, for OpenBot's log, when the browser did not answer in time. */
export const NOT_ANSWERING = `The browser did not answer within ${STATE_ANSWER_MS / 1000} s.`;

/** The work's value if it settles within `ms`, else nothing; it is left running, and a rejection is the caller's. */
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ value: T } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Enough of a contract schema to check a body with, whichever copy of zod built it. */
export type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: { path: PropertyKey[]; message: string }[] };
      };
};

/** The first thing wrong with a body, in the words of the field it is about. */
export function parseBody<T>(
  schema: Schema<T>,
  body: unknown,
): { ok: true; value: T } | { ok: false; error: string; response: Response } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length
    ? `${issue.path.map(String).join(".")}: `
    : "";
  const error = `${where}${issue?.message ?? "That request is not valid."}`;
  return { ok: false, error, response: json({ error }, 400) };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A person's browser's opens: how many have arrived and not finished, and the newest connection any brought. */
type Opening = {
  /** Settles when the last open to arrive has finished, so the next waits for it. */
  turn: Promise<unknown>;
  pending: number;
  /** None while no open among them brought one: each then leaves the Recorder the connection it holds. */
  newest?: NonNullable<BrowserOpenRequest["connection"]>;
};

export function createBrowserHost(options: BrowserHostOptions) {
  const { profiles } = options;
  const bar = createTabBar({
    navigationTimeoutMs: options.navigationTimeoutMs,
  });

  /**
   * In a native window the person changes tabs in the browser itself, which tells this process
   * nothing, so the tab in front is asked of the pages: the one the browser is showing, and of two
   * windows showing a tab each, the one with the focus. With no window in focus (the person is in
   * OpenBot), the tab already in front stays while it still shows; and a minimised browser, where
   * none shows, keeps the one it had.
   *
   * This reads true only because a native window has no focus emulation (`native-browser.ts`): with
   * it, every tab said it was showing and focused, and the person's own switch was never seen.
   */
  const followNativeTabs = async (browser: OpenPersonBrowser) => {
    if (browser.window !== "native") return;
    const pages = browser.pages();
    const hidden = { showing: false, focused: false };
    const shown = await Promise.all(
      pages.map((page) =>
        Promise.race([
          page
            .evaluate(() => ({
              showing: document.visibilityState === "visible",
              focused: document.hasFocus(),
            }))
            .catch(() => hidden),
          new Promise<typeof hidden>((resolve) =>
            setTimeout(() => resolve(hidden), VISIBILITY_MS),
          ),
        ]),
      ),
    );
    const showing = pages.filter((_, index) => shown[index]?.showing);
    const focused = pages.find(
      (_, index) => shown[index]?.showing && shown[index]?.focused,
    );
    const front =
      focused ??
      (showing.includes(browser.active()) ? undefined : showing.at(-1));
    if (front && front !== browser.active()) browser.activate(front);
  };

  const stateOf = async (
    browser: OpenPersonBrowser,
    recorder?: LauncherState,
    reportWithinMs?: number,
  ): Promise<BrowserState> => {
    // The Recorder's own report, when it answers. A Recorder that is starting or busy leaves it out
    // rather than failing the whole answer: the tabs are still worth showing. Asked beside the tabs,
    // and, where the caller says, for no longer than that.
    const ask = (): Promise<LauncherState | undefined> => {
      const asked = browser.launcher.state().catch(() => undefined);
      return reportWithinMs === undefined
        ? asked
        : within(asked, reportWithinMs).then((answer) => answer?.value);
    };
    const [report, tabs] = await Promise.all([
      recorder ?? ask(),
      bar.tabsOf(browser),
    ]);
    return {
      open: true,
      browser: browser.product,
      window: browser.window,
      ...(report ? { recorder: report } : {}),
      tabs,
    };
  };

  /**
   * The state the state route answers: the browser's own, asked once however often it is asked meanwhile. The page asks
   * every second, and a browser that does not answer would otherwise gather one unanswered question a second for as
   * long as it does not.
   */
  const asking = new WeakMap<BrowserContext, Promise<BrowserState>>();
  /** The browsers last found not answering, so the log says when one stops answering rather than every second. */
  const notAnswering = new WeakSet<BrowserContext>();
  const currentState = (browser: OpenPersonBrowser): Promise<BrowserState> => {
    const pending = asking.get(browser.context);
    if (pending) return pending;
    const asked = (async () => {
      await followNativeTabs(browser);
      return stateOf(browser, undefined, RECORDER_REPORT_MS);
    })();
    asking.set(browser.context, asked);
    void asked
      .finally(() => {
        if (asking.get(browser.context) === asked)
          asking.delete(browser.context);
      })
      .catch(() => undefined);
    return asked;
  };

  const closedState: BrowserState = { open: false, tabs: [] };

  /*
   * OPENS OF ONE BROWSER TAKE TURNS, AND EACH HANDS THE RECORDER THE NEWEST CONNECTION.
   *
   * Every open carries a connection OpenBot minted for it, and minting one revokes the one before:
   * the browser holds one connection, by its install id. Two opens close together, which is what the
   * Browser page sends when it is loaded again while it is still opening, used to run side by side.
   * The first handed the Recorder a connection the second had revoked already, the Recorder refused
   * it as signed out, and the first closed the browser it had just launched, under the second, whose
   * own connect then failed with "The browser is shutting down". Both answered 502 and the browser
   * stayed closed. Measured on Google Chrome 156 with the built Recorder and the real server, after a
   * restart with a newer Recorder, whose reload makes the first open take 2.7 s: two opens 1 s or
   * 2.5 s apart failed both, every time; 3.5 s apart, the first had finished and both opened.
   *
   * So an open waits for the one before it, and connects the Recorder with the newest connection any
   * open has brought, which is the one OpenBot holds: an open that had waited finds the Recorder
   * holding it already, which connects at once. And a browser no open has connected since it
   * launched is closed after a failed connect only when no other open is waiting to connect it.
   */
  const openings = new Map<string, Opening>();
  /** The browsers an open has connected since they launched, by their context, which is theirs alone. */
  const connectedOnce = new WeakSet<BrowserContext>();

  async function open(botId: string, body: unknown): Promise<Response> {
    const arrived = Date.now();
    /*
     * Every open that fails says why in the log, with the step it stopped at: which part of opening
     * (the launch, the Recorder's load or reload, its worker, the microphone, the connect) failed,
     * and how. Without it a failed open said only that the browser was then stopped. The log keeps
     * `reason`, what went wrong in its own words, where the caller is answered with a sentence for
     * the person instead.
     */
    const failed = (
      step: PersonOpenStep | "request",
      status: number,
      error: string,
      reason: string = error,
    ): Response => {
      console.info(
        JSON.stringify({
          type: "computer-browser-open-failed",
          botId,
          step,
          status,
          error: reason,
          ms: Date.now() - arrived,
        }),
      );
      return json({ error }, status);
    };
    const parsed = parseBody(browserOpenRequestSchema, body);
    if (!parsed.ok) return failed("request", 400, parsed.error);

    const brought = parsed.value.connection;
    const opening: Opening = openings.get(botId) ?? {
      turn: Promise.resolve(),
      pending: 0,
    };
    openings.set(botId, opening);
    if (brought) opening.newest = brought;
    opening.pending += 1;
    const done = () => {
      opening.pending -= 1;
      if (opening.pending === 0 && openings.get(botId) === opening)
        openings.delete(botId);
    };
    const run = opening.turn.then(() => openNow(botId, opening, failed));
    opening.turn = run.then(done, done);
    return run;
  }

  async function openNow(
    botId: string,
    opening: Opening,
    failed: (
      step: PersonOpenStep,
      status: number,
      error: string,
      reason?: string,
    ) => Response,
  ): Promise<Response> {
    const found = await findRecorder(options.recorderDir());
    if (!found.ok) return failed("recorder-files", 503, found.error);

    const wasOpen = profiles.person(botId) !== undefined;
    let page: Page;
    try {
      page = await profiles.page(botId, { open: { recorder: found.recorder } });
    } catch (error) {
      if (error instanceof NoInstalledBrowserError)
        return failed("launch", 503, error.message);
      const at = error instanceof PersonOpenError ? error.step : "launch";
      /*
       * A browser this computer cannot run at all (Playwright's Chromium missing from a hosted image,
       * say) is OpenBot's setup: 503, in the computer's own words for whoever runs OpenBot, which the
       * server keeps in its log and never shows the person, as for a missing Recorder. Run 4 saw such
       * a failure reach the person as a 502 with Playwright's text, its install box included.
       */
      if (error instanceof PersonOpenError && error.setup)
        return failed(at, 503, error.message);
      return failed(at, 502, NOT_OPENED, messageOf(error));
    }
    const browser = profiles.person(botId);
    if (!browser) return failed("launch", 409, BROWSER_NOT_OPEN);
    // Already open: the window comes to the front and nothing new opens.
    if (wasOpen && browser.window === "native")
      await bar.putInFront(browser, page);

    /*
     * An open that brought no connection, with none from another open waiting either, hands the Recorder nothing: it
     * keeps the connection it holds, which the state this answers names (`recorder.connectionId`). OpenBot opens so
     * when it holds a connection that stands for this browser, and connects it with a new one only if the Recorder
     * turns out not to hold that one.
     */
    const connection = opening.newest;
    if (!connection) {
      try {
        return json(await stateOf(browser));
      } catch (error) {
        return failed("state", 502, NOT_OPENED, messageOf(error));
      }
    }

    // Who hears the person: the Recorder itself in a native window, the app's page in a hosted one.
    const narration: Narration =
      browser.window === "native" ? "own" : "external";
    let connected: Awaited<ReturnType<typeof browser.launcher.connect>>;
    try {
      // Every open that brings one, not only the first: idempotent, and the connection the server sent
      // last is the one the Recorder should hold.
      connected = await browser.launcher.connect({ connection, narration });
    } catch (error) {
      connected = {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "The Recorder did not answer.",
      };
    }
    if (!connected.ok) {
      // A browser no open has connected since it launched is closed again: the person was promised
      // one that is connected. Not while another open waits to connect it, with a connection as new
      // as this one or newer: closing it would fail that open too. One that was connected stays,
      // with the person's tabs.
      if (!connectedOnce.has(browser.context) && opening.pending <= 1)
        await profiles.stop(botId, "its Recorder could not be connected");
      return failed(
        "connect",
        502,
        `The Recorder could not be connected: ${connected.error}`,
      );
    }
    connectedOnce.add(browser.context);
    try {
      return json(await stateOf(browser));
    } catch (error) {
      // The browser went away between the connect and its state: closed by the person, or crashed.
      return failed("state", 502, NOT_OPENED, messageOf(error));
    }
  }

  /**
   * Wipe the person's browser, open or closed (`shared/bot-browser.ts`, CLEARING A BROWSER), and leave it closed: only
   * the server can hand its Recorder a connection, so it is the server that opens it again. A recording running in it
   * is stopped first, and the last of it waited for, because what it has not sent is kept in the storage about to go.
   * Never fails for the Recorder: a browser cleared because it went wrong may well have a Recorder that does not answer,
   * and is cleared all the same.
   */
  async function clear(botId: string): Promise<Response> {
    const browser = profiles.person(botId);
    if (browser) {
      try {
        const report = await browser.launcher.state();
        if (report.phase !== "idle") {
          const stopped = await browser.launcher.record({ action: "stop" });
          const sent = await untilSent(
            browser.launcher,
            stopped.ok ? stopped.state : report,
            options.sendingWaitMs ?? SENDING_WAIT_MS,
          );
          console.info(
            JSON.stringify({
              type: "computer-browser-recording-ended",
              botId,
              reason: "the browser's data was cleared",
              ...(stopped.ok ? {} : { error: stopped.error }),
              ...(sent.stillSending ? { stillSending: true } : {}),
            }),
          );
        }
      } catch (error) {
        console.info(
          JSON.stringify({
            type: "computer-browser-recording-not-ended",
            botId,
            error: messageOf(error),
          }),
        );
      }
    }
    await profiles.clear(botId, () => options.forget?.(botId));
    console.info(JSON.stringify({ type: "computer-browser-cleared", botId }));
    return json(closedState);
  }

  async function handle(
    request: Request,
    pathname: string,
    botId: string,
  ): Promise<Response> {
    if (!isPersonBrowserId(botId))
      return json(
        {
          error:
            "The browser routes are for a person's browser: send its id (person- and 32 hex digits) in x-openbot-bot-id.",
        },
        400,
      );
    const method = pathname === browserComputerPaths.state ? "GET" : "POST";
    if (request.method !== method)
      return json({ error: `Use ${method} for ${pathname}.` }, 405);
    const body =
      method === "POST" ? await request.json().catch(() => null) : null;

    if (pathname === browserComputerPaths.open) return open(botId, body);

    if (pathname === browserComputerPaths.close) {
      await profiles.stop(botId);
      return json(closedState);
    }

    if (pathname === browserComputerPaths.clear) return clear(botId);

    /*
     * OpenBot revoked this browser's connection: the Recorder forgets it now rather than at its next
     * call to OpenBot. A closed browser has no Recorder running to tell, and is not opened to tell
     * it: the next open hands the Recorder whatever connection OpenBot gives it then.
     */
    if (pathname === browserComputerPaths.disconnect) {
      const browser = profiles.person(botId);
      if (!browser) return json(closedState);
      try {
        const result = await browser.launcher.disconnect();
        if (!result.ok) return json({ error: result.error }, 409);
      } catch (error) {
        if (error instanceof RecorderUnavailableError)
          return json({ error: error.message }, 502);
        throw error;
      }
      return json(await stateOf(browser));
    }

    // Validated before asking whether the browser is open, so a malformed call says what is wrong
    // with it rather than that there is nothing to act on.
    const recording =
      pathname === browserComputerPaths.recording
        ? parseBody(browserRecordingRequestSchema, body)
        : undefined;
    const narration =
      pathname === browserComputerPaths.narration
        ? parseBody(browserNarrationRequestSchema, body)
        : undefined;
    const tabs =
      pathname === browserComputerPaths.tabs
        ? parseBody(browserTabsRequestSchema, body)
        : undefined;
    const navigate =
      pathname === browserComputerPaths.navigate
        ? parseBody(browserNavigateRequestSchema, body)
        : undefined;
    for (const parsed of [recording, narration, tabs, navigate])
      if (parsed && !parsed.ok) return parsed.response;

    const browser = profiles.person(botId);
    if (pathname === browserComputerPaths.state) {
      if (!browser) return json(closedState);
      /*
       * A browser that does not answer in time is said to be open and not answering, as a 504 with a sentence, and the
       * question is left running for the next ask to join. There is no rule here that closes or restarts one: a browser
       * that answers again is shown again, and closing it is the person's (`/browser/close`) or the idle sweep's.
       */
      const answered = await within(currentState(browser), STATE_ANSWER_MS);
      if (!answered) {
        if (!notAnswering.has(browser.context)) {
          notAnswering.add(browser.context);
          console.warn(
            JSON.stringify({
              type: "computer-browser-not-answering",
              botId,
              ms: STATE_ANSWER_MS,
            }),
          );
        }
        return json({ error: NOT_ANSWERING }, 504);
      }
      notAnswering.delete(browser.context);
      return json(answered.value);
    }
    if (!browser) return json({ error: BROWSER_NOT_OPEN }, 409);

    try {
      if (recording?.ok) {
        await followNativeTabs(browser);
        // The Recorder records the tab the browser has in front, so a hosted browser's front tab is
        // made the one the live screen shows before it starts.
        if (recording.value.action === "start" && browser.window === "screen")
          await bar.putInFront(browser, browser.active());
        const result = await browser.launcher.record(recording.value);
        if (!result.ok) return json({ error: result.error }, 409);
        return json(await stateOf(browser, result.state));
      }

      if (narration?.ok) {
        /*
         * A phrase, or the person starting or stopping one. The times are already on the server's
         * clock, which corrected them by `sentAt` on the way (see the contract); `sentAt` itself is
         * the server's own and goes no further.
         */
        const said = narration.value;
        const result =
          "text" in said
            ? await browser.launcher.narrate({
                text: said.text,
                startedAt: said.startedAt,
                endedAt: said.endedAt,
              })
            : await browser.launcher.speaking({
                since: said.speaking ? said.since : null,
              });
        if (!result.ok) return json({ error: result.error }, 409);
        return json({ ok: true });
      }

      if (tabs?.ok) {
        const done = await bar.tabs(browser, tabs.value);
        if (!done.ok) return json({ error: done.error }, done.status);
        // A closed tab can take the browser's last window with it.
        const after = profiles.person(botId);
        return json(after ? await stateOf(after) : closedState);
      }

      if (navigate?.ok) {
        await followNativeTabs(browser);
        const done = await bar.navigate(browser, navigate.value);
        if (!done.ok) return json({ error: done.error }, done.status);
        return json(await stateOf(browser));
      }
    } catch (error) {
      if (error instanceof BrowserNotOpenError)
        return json({ error: error.message }, 409);
      if (error instanceof RecorderUnavailableError)
        return json({ error: error.message }, 502);
      throw error;
    }
    return json({ error: "Not found." }, 404);
  }

  return { handle };
}

export type BrowserHost = ReturnType<typeof createBrowserHost>;

/** Whether a path is one of these routes, so the dispatcher hands it over. */
export function isBrowserPath(pathname: string): boolean {
  return (Object.values(browserComputerPaths) as string[]).includes(pathname);
}
