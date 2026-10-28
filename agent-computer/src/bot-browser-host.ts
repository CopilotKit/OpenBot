/**
 * A Bot's browser, worked by a person holding its wheel: the bar above its screen (tabs, the address, back, forward
 * and reload) and the Recorder loaded in it, which records only that person. The contract is
 * `shared/bot-browser.ts`; these are its computer routes (`botBrowserComputerPaths`).
 *
 * Under the computer token like every other route, with the Bot's id in `x-openbot-bot-id`; `index.ts` checks the
 * token, this checks the id. The server is the only caller: it decides who the signed-in person is and whether they
 * may use the Bot, mints the Recorder connection for the person who pressed Record, and forwards here.
 *
 * WHO MAY DO WHAT is asked of the Bot's control (`control.ts`) at every call, never remembered from an earlier one:
 * the bar works while a person holds the wheel, and a recording starts only for the person named as holding it
 * (`heldBy`). Whatever the Bot was doing has drained before either is true, and it cannot act while they are, so
 * everything the bar does and the Recorder records is the person's.
 *
 * A RECORDING ENDS WHEN THE WHEEL LEAVES ITS PERSON. The control says so (`onWheelLeft`): they hand it back, the
 * request they took is cancelled, a stop or reset interrupts it, the browser or the computer starts again. The browser
 * closing says so too (`browserClosing`), and so does the person clearing it (`clear`). Each ends the recording, then
 * disconnects the Recorder, so the Recorder in a Bot's browser never holds a person's connection longer than their
 * recording.
 *
 * Its own module, taking the browsers and controls it acts on, so a test can serve these exact routes.
 */
import type { BrowserContext } from "playwright";
import {
  type BotBrowserComputerRecordingRequest,
  type BotBrowserState,
  botBrowserComputerClearRequestSchema,
  botBrowserComputerPaths,
  botBrowserComputerRecordingRequestSchema,
} from "../../shared/bot-browser";
import {
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserTabsRequestSchema,
  isPersonBrowserId,
  type LauncherState,
} from "../../shared/openbot-browser";
import { parseBody } from "./browser-host";
import { createTabBar, type TabbedBrowser } from "./browser-tabs";
import { type Control, TAKE_CONTROL_FIRST } from "./control";
import { BrowserNotOpenError } from "./person-access";
import type { OpenBotBrowser, Profiles } from "./profiles";
import {
  type RecorderLauncher,
  RecorderUnavailableError,
  SENDING_WAIT_MS,
  untilSent,
} from "./recorder-launcher";

// Where `bot-browser.test.ts` keeps it in step with the gateway's own timeout.
export { SENDING_WAIT_MS };

export type BotBrowserHostOptions = {
  profiles: Profiles;
  /** The Bot's control, asked at every call who holds the wheel. */
  control: (
    botId: string,
  ) => Pick<Control, "humanMayDrive" | "personMayRecord" | "personHolds">;
  /** Told each time a person works the bar, which is driving the browser as their input on the screen is. */
  drove?: (botId: string) => void;
  /**
   * Told while a Bot's browser is being cleared, once it has closed and before it can start again: the computer forgets
   * the browser it described (`profiles.clear`).
   */
  forget?: (botId: string) => void;
  navigationTimeoutMs: number;
  /** `SENDING_WAIT_MS` unless a test needs the bound to run out sooner. */
  sendingWaitMs?: number;
  /**
   * Why Record is refused in every Bot's browser on this computer (person-access.ts `NOT_ITS_OWN_COMPUTER_RECORD`):
   * it is the shared one. Absent on a computer started for one Bot.
   */
  recordRefused?: string;
};

/** Said to the person, through the server, for each refusal. */
const SENTENCES = {
  personsBrowser:
    "These routes are for a Bot's browser. A person's own browser has its own: send a Bot's id in x-openbot-bot-id.",
  onlyTheHolder:
    "Only the person holding control of this Bot's browser can record in it. Take control first.",
  onlyTheHolderClears:
    "Only the person holding control of this Bot's browser can clear it. Take control first.",
  alreadyRecording: "A recording is already running in this Bot's browser.",
  notRecording: "Nothing is being recorded in this Bot's browser.",
  noRecorder:
    "This Bot's browser cannot record: the OpenBot Recorder is not installed on its computer.",
  recorderDidNotStart:
    "The Recorder in this Bot's browser did not start, so it cannot record. Stop the Bot's computer and try again.",
  notStarted: "This Bot's browser could not be started. Try again.",
  notOpen: "This Bot's browser is not open.",
  notConnected:
    "The Recorder in this Bot's browser could not be connected. Try again.",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A recording running in a Bot's browser: whose it is, and the browser and Recorder it runs in. */
type Recording = {
  by: string;
  /** The Recorder's id for it, as Record answered. */
  recordingId?: string;
  context: BrowserContext;
  launcher: RecorderLauncher;
};

export function createBotBrowserHost(options: BotBrowserHostOptions) {
  const { profiles } = options;
  const bar = createTabBar({
    navigationTimeoutMs: options.navigationTimeoutMs,
  });
  const recordings = new Map<string, Recording>();
  /**
   * The Recorder's last report from each browser, kept while nothing is being recorded. A disconnected Recorder's
   * report cannot change until a recording starts, and asking for it wakes the Recorder's worker when it is asleep,
   * so the bar's state, which the app reads while the Bot's screen is open, asks once per browser and not each time.
   */
  const reports = new WeakMap<BrowserContext, LauncherState>();
  /**
   * Whose recording each browser's Recorder stopped last, by that recording's id, so the bar names the person beside
   * the Recorder's `lastStopped` only while that is the recording it names.
   */
  const stoppedBy = new WeakMap<
    BrowserContext,
    { recordingId: string; by: string }
  >();
  /**
   * Starting, stopping and ending a Bot's recording take turns, one after another per Bot, so a hand-back that lands
   * while Record is still starting ends the recording Record started rather than missing it.
   */
  const turns = new Map<string, Promise<unknown>>();

  const inTurn = <T>(botId: string, work: () => Promise<T>): Promise<T> => {
    const run = (turns.get(botId) ?? Promise.resolve()).then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    turns.set(botId, settled);
    void settled.then(() => {
      if (turns.get(botId) === settled) turns.delete(botId);
    });
    return run;
  };

  /** The running recording, if the browser it runs in is still the Bot's browser. One whose browser went is over. */
  const recordingOf = (botId: string): Recording | undefined => {
    const current = recordings.get(botId);
    if (!current) return undefined;
    if (profiles.bot(botId)?.context === current.context) return current;
    recordings.delete(botId);
    return undefined;
  };

  const tabbed = async (view: OpenBotBrowser): Promise<TabbedBrowser> => ({
    context: view.context,
    session: await view.session(),
    window: "screen",
    active: view.active,
    activate: view.activate,
    pages: view.pages,
  });

  const stateOf = async (
    botId: string,
    view: OpenBotBrowser,
    fresh?: LauncherState,
  ): Promise<BotBrowserState> => {
    const recording = recordingOf(botId);
    const recorder = view.recorder;
    let report = fresh ?? reports.get(view.context);
    // Asked live while a recording runs, when it changes with every step; otherwise once, then kept.
    if (recorder && !recorder.problem && (recording || !report))
      report = await recorder.launcher.state().catch(() => report);
    if (report) reports.set(view.context, report);
    const stopped = stoppedBy.get(view.context);
    const lastStoppedBy =
      stopped && report?.lastStopped?.recordingId === stopped.recordingId
        ? stopped.by
        : undefined;
    return {
      open: true,
      tabs: await bar.tabsOf(await tabbed(view)),
      ...(report ? { recorder: report } : {}),
      ...(recording ? { recordingBy: recording.by } : {}),
      ...(lastStoppedBy ? { lastStoppedBy } : {}),
    };
  };

  const closedState: BotBrowserState = { open: false, tabs: [] };

  /** The Bot's browser, started if it is not running, as a person's input on the screen starts it. */
  const running = async (botId: string): Promise<OpenBotBrowser | Response> => {
    try {
      await profiles.page(botId);
    } catch (error) {
      console.info(
        JSON.stringify({
          type: "computer-bot-browser-not-started",
          botId,
          error: messageOf(error),
        }),
      );
      return json({ error: SENTENCES.notStarted }, 502);
    }
    return profiles.bot(botId) ?? json({ error: SENTENCES.notOpen }, 409);
  };

  /**
   * Wait, after a Stop, until the Recorder says the last of the recording it stopped has reached Intelligence, or the
   * bound runs out (`untilSent`), saying in the log when it ran out. Answers its newest report.
   *
   * WHY. Stop answers once the recording's outcome is queued; the rest goes to Intelligence after. A disconnect then
   * keeps whatever has not gone for the person's next connection in this browser, which on a Bot shared by several
   * people may be never, and the server revokes the connection and narrows the Bot's network as soon as the computer
   * answers. So the Recorder is let go only once nothing of the recording is still on its way (`lastStopped.sending`).
   */
  const whenSent = async (
    botId: string,
    launcher: RecorderLauncher,
    report: LauncherState | undefined,
  ): Promise<LauncherState | undefined> => {
    const started = Date.now();
    const sent = await untilSent(
      launcher,
      report,
      options.sendingWaitMs ?? SENDING_WAIT_MS,
    );
    if (sent.stillSending)
      console.info(
        JSON.stringify({
          type: "computer-bot-recording-still-sending",
          botId,
          waitedMs: Date.now() - started,
          note: "The Recorder keeps what it has not sent for the person's next connection in this browser.",
        }),
      );
    return sent.report;
  };

  /**
   * End a Bot's recording: stop it, wait for the last of it to reach Intelligence, then disconnect the Recorder, so it
   * holds the person's connection no longer than their recording needs. Answers the Recorder's report after the stop,
   * which names the recording it ended. No step failing keeps the next from being tried, and nothing here throws: an
   * ending is the wheel moving on, and it moves on either way.
   */
  const end = async (
    botId: string,
    reason: string,
  ): Promise<LauncherState | undefined> => {
    const current = recordings.get(botId);
    if (!current) return undefined;
    // First, so narration arriving while it stops is refused rather than sent to a recording that is ending.
    recordings.delete(botId);
    let report: LauncherState | undefined;
    let error: string | undefined;
    try {
      const stopped = await current.launcher.record({ action: "stop" });
      if (stopped.ok) report = stopped.state;
      else error = stopped.error;
    } catch (failure) {
      error = messageOf(failure);
    }
    report = await whenSent(botId, current.launcher, report);
    try {
      const disconnected = await current.launcher.disconnect();
      if (!disconnected.ok) error ??= disconnected.error;
      report = await current.launcher.state().catch(() => report);
    } catch (failure) {
      error ??= messageOf(failure);
    }
    if (report) reports.set(current.context, report);
    if (current.recordingId)
      stoppedBy.set(current.context, {
        recordingId: current.recordingId,
        by: current.by,
      });
    console.info(
      JSON.stringify({
        type: "computer-bot-recording-ended",
        botId,
        reason,
        ...(error ? { error } : {}),
      }),
    );
    return report;
  };

  async function start(
    botId: string,
    input: Extract<BotBrowserComputerRecordingRequest, { action: "start" }>,
  ): Promise<Response> {
    const control = options.control(botId);
    if (!control.personMayRecord(input.by))
      return json({ error: SENTENCES.onlyTheHolder }, 409);
    if (recordingOf(botId))
      return json({ error: SENTENCES.alreadyRecording }, 409);
    const view = await running(botId);
    if (view instanceof Response) return view;
    const recorder = view.recorder;
    if (!recorder) return json({ error: SENTENCES.noRecorder }, 503);
    if (recorder.problem) {
      console.info(
        JSON.stringify({
          type: "computer-bot-recording-refused",
          botId,
          reason: recorder.problem,
        }),
      );
      return json({ error: SENTENCES.recorderDidNotStart }, 503);
    }
    const { launcher } = recorder;
    // The person's connection, for this recording only; narration is the app's, since this browser has no microphone.
    const connected = await launcher.connect({
      connection: input.connection,
      narration: "external",
    });
    if (!connected.ok) {
      // The Recorder's own words are for the log: the person is told what happened, in OpenBot's.
      console.info(
        JSON.stringify({
          type: "computer-bot-recording-connect-failed",
          botId,
          reason: connected.error,
        }),
      );
      return json({ error: SENTENCES.notConnected }, 502);
    }
    let started: Awaited<ReturnType<RecorderLauncher["record"]>>;
    try {
      // The Recorder records the tab in front, which is made the one the live screen shows first.
      const browser = await tabbed(view);
      await bar.putInFront(browser, browser.active());
      started = await launcher.record({
        action: "start",
        title: input.title,
        ...(input.language ? { language: input.language } : {}),
      });
    } catch (error) {
      // Connected for a recording that did not start: the connection goes again at once.
      await launcher.disconnect().catch(() => undefined);
      throw error;
    }
    if (!started.ok) {
      await launcher.disconnect().catch(() => undefined);
      return json({ error: started.error }, 409);
    }
    recordings.set(botId, {
      by: input.by,
      ...(started.state.recordingId
        ? { recordingId: started.state.recordingId }
        : {}),
      context: view.context,
      launcher,
    });
    // The wheel can move while Record starts. The ending it asked for waits its turn behind this one, so it is made
    // here: a recording never outlives the person's hold on the wheel by even one step.
    if (!control.personMayRecord(input.by)) {
      await end(botId, "the wheel left the person while Record started");
      return json({ error: SENTENCES.onlyTheHolder }, 409);
    }
    console.info(
      JSON.stringify({ type: "computer-bot-recording-started", botId }),
    );
    return json(await stateOf(botId, view, started.state));
  }

  /**
   * Clear the Bot's browser for the person holding its wheel (`shared/bot-browser.ts`, CLEARING A BROWSER): their
   * recording, if one runs, ends and is let go first, as a closing browser's does; then the profile goes; then the
   * browser starts again, fresh, under them. In the recordings' turn, so a Record pressed meanwhile starts in the fresh
   * browser rather than in the one being wiped. A browser that does not start again is still cleared, and said closed.
   */
  async function clear(botId: string, by: string): Promise<Response> {
    return inTurn(botId, async () => {
      if (!options.control(botId).personHolds(by))
        return json({ error: SENTENCES.onlyTheHolderClears }, 409);
      await end(botId, "the browser's data was cleared");
      await profiles.clear(botId, () => options.forget?.(botId));
      console.info(
        JSON.stringify({ type: "computer-bot-browser-cleared", botId }),
      );
      const view = await running(botId);
      if (view instanceof Response) return json(closedState);
      return json(await stateOf(botId, view));
    });
  }

  async function handle(
    request: Request,
    pathname: string,
    botId: string,
  ): Promise<Response> {
    if (isPersonBrowserId(botId))
      return json({ error: SENTENCES.personsBrowser }, 400);
    const method = pathname === botBrowserComputerPaths.state ? "GET" : "POST";
    if (request.method !== method)
      return json({ error: `Use ${method} for ${pathname}.` }, 405);
    const body =
      method === "POST" ? await request.json().catch(() => null) : null;

    // Validated before anything is asked of the browser, so a malformed call says what is wrong with it.
    const recording =
      pathname === botBrowserComputerPaths.recording
        ? parseBody(botBrowserComputerRecordingRequestSchema, body)
        : undefined;
    const narration =
      pathname === botBrowserComputerPaths.narration
        ? parseBody(browserNarrationRequestSchema, body)
        : undefined;
    const tabs =
      pathname === botBrowserComputerPaths.tabs
        ? parseBody(browserTabsRequestSchema, body)
        : undefined;
    const navigate =
      pathname === botBrowserComputerPaths.navigate
        ? parseBody(browserNavigateRequestSchema, body)
        : undefined;
    const clearing =
      pathname === botBrowserComputerPaths.clear
        ? parseBody(botBrowserComputerClearRequestSchema, body)
        : undefined;
    for (const parsed of [recording, narration, tabs, navigate, clearing])
      if (parsed && !parsed.ok) return parsed.response;

    try {
      if (clearing?.ok) return await clear(botId, clearing.value.by);

      if (pathname === botBrowserComputerPaths.state) {
        const view = profiles.bot(botId);
        if (!view) {
          recordingOf(botId);
          return json(closedState);
        }
        return json(await stateOf(botId, view));
      }

      if (tabs?.ok || navigate?.ok) {
        if (!options.control(botId).humanMayDrive())
          return json({ error: TAKE_CONTROL_FIRST }, 409);
        const view = await running(botId);
        if (view instanceof Response) return view;
        options.drove?.(botId);
        // Before the first switch of tabs, after which the live screen lost the bottom of the page.
        if (tabs?.ok) await view.fitWindows();
        const browser = await tabbed(view);
        const done = tabs?.ok
          ? await bar.tabs(browser, tabs.value)
          : navigate?.ok
            ? await bar.navigate(browser, navigate.value)
            : ({ ok: true } as const);
        if (!done.ok) return json({ error: done.error }, done.status);
        const after = profiles.bot(botId);
        return json(after ? await stateOf(botId, after) : closedState);
      }

      if (recording?.ok) {
        const asked = recording.value;
        if (asked.action === "start") {
          // Before the connection reaches a profile every Bot here could read.
          if (options.recordRefused)
            return json({ error: options.recordRefused }, 403);
          return await inTurn(botId, () => start(botId, asked));
        }
        return await inTurn(botId, async () => {
          if (!recordingOf(botId))
            return json({ error: SENTENCES.notRecording }, 409);
          const report = await end(botId, "stopped");
          const view = profiles.bot(botId);
          return json(view ? await stateOf(botId, view, report) : closedState);
        });
      }

      if (narration?.ok) {
        const current = recordingOf(botId);
        if (!current) return json({ error: SENTENCES.notRecording }, 409);
        /*
         * A phrase, or the person starting or stopping one, on the server's clock already (it corrected the times by
         * `sentAt` on the way, as for a person's browser); `sentAt` itself goes no further.
         */
        const said = narration.value;
        const result =
          "text" in said
            ? await current.launcher.narrate({
                text: said.text,
                startedAt: said.startedAt,
                endedAt: said.endedAt,
              })
            : await current.launcher.speaking({
                since: said.speaking ? said.since : null,
              });
        if (!result.ok) return json({ error: result.error }, 409);
        const view = profiles.bot(botId);
        return json(view ? await stateOf(botId, view) : closedState);
      }
    } catch (error) {
      if (error instanceof BrowserNotOpenError)
        return json({ error: SENTENCES.notOpen }, 409);
      if (error instanceof RecorderUnavailableError)
        return json({ error: error.message }, 502);
      throw error;
    }
    return json({ error: "Not found." }, 404);
  }

  return {
    handle,
    /**
     * The wheel left the person who held it (`onWheelLeft`): their recording, if one runs, ends. In its turn, after a
     * Record still starting. The control does not wait on it, but admits no Bot action until it settles.
     */
    wheelLeft(botId: string): Promise<unknown> {
      return inTurn(botId, () => end(botId, "the wheel left the person"));
    },
    /** The Bot's browser is closing: its recording ends while the Recorder can still be told. */
    async browserClosing(botId: string): Promise<void> {
      await inTurn(botId, () => end(botId, "the browser closed"));
    },
    /** Settles once every ending already asked for has finished, so a hand-back answers after the recording ended. */
    async settled(botId: string): Promise<void> {
      await turns.get(botId);
    },
  };
}

export type BotBrowserHost = ReturnType<typeof createBotBrowserHost>;

/** Whether a path is one of these routes, so the dispatcher hands it over. */
export function isBotBrowserPath(pathname: string): boolean {
  return (Object.values(botBrowserComputerPaths) as string[]).includes(
    pathname,
  );
}
