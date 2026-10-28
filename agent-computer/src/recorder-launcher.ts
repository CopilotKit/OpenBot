/**
 * The Recorder's launcher API, called inside its service worker over this process's DevTools pipe.
 *
 * WHY THROUGH THE WORKER. The Recorder takes its connection and its commands only from whoever
 * launched the browser: `globalThis.openbotLauncher` in its service worker, with no message route to
 * it from a web page or another extension. Only this process holds the browser's DevTools pipe, so
 * only this process can call it.
 *
 * FOUND BY RAW TARGETS. Playwright's `serviceWorkers()` did not report the Recorder's worker after a
 * DevTools `Extensions.loadUnpacked` in branded Chrome, so the worker is found the way DevTools
 * itself finds one: `Target.getTargets`, a `service_worker` whose url is the Recorder's.
 *
 * ATTACHED WITHOUT FLATTENING. Playwright's public DevTools sessions attach only to pages and frames,
 * so a session to the worker is opened from the browser session with `Target.attachToTarget` and
 * spoken to with `Target.sendMessageToTarget`. The protocol marks that non-flat mode as one it means
 * to retire in favour of flat sessions (crbug.com/991325), which Playwright does not expose for a
 * worker; `person-browser.test.ts` drives it against real Chromium and Chrome, so a browser that
 * drops it is caught there.
 *
 * WOKEN WHEN ASLEEP. An MV3 service worker stops after about thirty seconds with nothing to do, and
 * a stopped worker has no target to attach to. `ServiceWorker.startWorker` with the extension's scope
 * starts it again; the ServiceWorker domain answers only on a page session, so it is asked through
 * one of the browser's pages. A worker that has just started can be evaluated in before its script
 * has run (crbug.com/341213355), so every call first waits until the launcher is defined.
 * https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/#method-startWorker
 * https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import {
  LAUNCHER_GLOBAL,
  type LauncherApi,
  type LauncherResult,
  type LauncherState,
} from "../../shared/openbot-browser";

/** The Recorder did not answer: not loaded, not started, or without the launcher. */
export class RecorderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecorderUnavailableError";
  }
}

/**
 * How long ending a recording waits for the last of it to reach Intelligence before the Recorder is let go all the
 * same (`untilSent`): a rejoin and a push, each given the gateway's own timeout (`PHOENIX_TIMEOUT_MS`, 10 s, in
 * `extension/src/offscreen/phoenix-session.ts`; `bot-browser.test.ts` keeps the two in step). Well inside the 45 s
 * the server gives a call to the computer, so Stop, a hand-back and a clear still answer, and the server revokes the
 * person's connection only after.
 */
export const SENDING_WAIT_MS = 2 * 10_000;
/** How often the Recorder is asked whether the last of a recording has gone (`untilSent`). */
const SENDING_POLL_MS = 250;

/**
 * Wait, after a Stop, until the Recorder says the last of the recording it stopped has reached Intelligence
 * (`lastStopped.sending` gone), or `waitMs` runs out. Answers its newest report, and whether it was still sending when
 * the wait ran out.
 *
 * WHY. Stop answers once the recording's outcome is queued; the rest goes to Intelligence after, and until it has gone
 * it is kept in the Recorder's own storage. Whoever lets the Recorder go after a Stop waits on this first: a disconnect
 * keeps what is not sent for the person's next connection in that browser, and clearing the browser deletes that
 * storage outright.
 */
export async function untilSent(
  launcher: Pick<LauncherApi, "state">,
  report: LauncherState | undefined,
  waitMs: number,
): Promise<{ report: LauncherState | undefined; stillSending: boolean }> {
  const recordingId = report?.lastStopped?.recordingId;
  if (!recordingId || !report?.lastStopped?.sending)
    return { report, stillSending: false };
  const deadline = Date.now() + waitMs;
  let latest = report;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SENDING_POLL_MS));
    // A Recorder too busy to answer is asked again, within the bound.
    const now = await launcher.state().catch(() => undefined);
    if (!now) continue;
    latest = now;
    if (
      now.lastStopped?.recordingId !== recordingId ||
      !now.lastStopped.sending
    )
      return { report: now, stillSending: false };
  }
  return { report: latest, stillSending: true };
}

/** How long a worker that is starting gets to appear and define its launcher. */
const WORKER_START_MS = 10_000;
/** How long one launcher call may take. Starting a recording attaches the debugger to a tab. */
const CALL_MS = 15_000;
/** How long the question "is the launcher there" may take before the session is replaced. */
const READY_MS = 2_000;
const POLL_MS = 100;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type TargetInfo = { targetId: string; type: string; url: string };

/** A DevTools event from inside the worker. */
type WorkerEvent = { method?: string; params?: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const WORKER_STOPPED = "The Recorder's worker stopped mid-call.";

export type RecorderLauncher = LauncherApi & {
  /**
   * The source of the script the Recorder's worker is running now, as its JavaScript engine parsed
   * it, or undefined when the worker reports no script at `url`. See `keepRecorderCurrent` in
   * `person-browser.ts` for why it is asked.
   */
  workerSource(url: string): Promise<string | undefined>;
};

export function createRecorderLauncher(input: {
  /** A browser-level session (`browser.newBrowserCDPSession()`), which alone can reach the worker. */
  session: CDPSession;
  context: BrowserContext;
  recorderId: string;
}): RecorderLauncher {
  const { session, context, recorderId } = input;
  const scope = `chrome-extension://${recorderId}/`;
  let attached: { targetId: string; sessionId: string } | undefined;
  let attaching: Promise<string> | undefined;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: WorkerEvent) => void>();

  session.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== attached?.sessionId) return;
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(event.message);
    } catch {
      return;
    }
    if (message.id === undefined) {
      // An event, which only a caller that asked for one listens to.
      for (const listener of listeners) listener(message);
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error)
      waiting.reject(
        new RecorderUnavailableError(
          `The Recorder's worker refused a call: ${message.error.message ?? "unknown error"}`,
        ),
      );
    else waiting.resolve(message.result);
  });

  // A worker that stopped takes its session with it. The next call finds or wakes a new one.
  session.on("Target.detachedFromTarget", (event) => {
    if (event.sessionId !== attached?.sessionId) return;
    attached = undefined;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.reject(new RecorderUnavailableError(WORKER_STOPPED));
    }
  });

  const findWorker = async (): Promise<TargetInfo | undefined> => {
    const { targetInfos } = (await session.send("Target.getTargets")) as {
      targetInfos: TargetInfo[];
    };
    return targetInfos.find(
      (target) =>
        target.type === "service_worker" && target.url.startsWith(scope),
    );
  };

  /** Ask the browser to start the Recorder's worker, through any page it has open. */
  const wake = async (): Promise<void> => {
    const page: Page | undefined = context
      .pages()
      .find((candidate) => !candidate.isClosed());
    if (!page) return;
    const pageSession = await context.newCDPSession(page);
    try {
      await pageSession.send("ServiceWorker.enable");
      await pageSession.send("ServiceWorker.startWorker", { scopeURL: scope });
    } finally {
      await pageSession.detach().catch(() => undefined);
    }
  };

  const workerTarget = async (): Promise<TargetInfo> => {
    const deadline = Date.now() + WORKER_START_MS;
    let lastWake = 0;
    for (;;) {
      const found = await findWorker();
      if (found) return found;
      if (Date.now() > deadline)
        throw new RecorderUnavailableError(
          "The Recorder in this browser did not start.",
        );
      // Right after a load the worker is starting on its own; asked again each second after that,
      // because a wake can land before the extension's registration is ready to start.
      if (Date.now() - lastWake >= 1_000) {
        lastWake = Date.now();
        await wake().catch(() => undefined);
      }
      await sleep(POLL_MS);
    }
  };

  /** Leave a session that no longer answers, so the next call attaches afresh. */
  const drop = () => {
    const stale = attached;
    attached = undefined;
    if (stale)
      void session
        .send("Target.detachFromTarget", { sessionId: stale.sessionId })
        .catch(() => undefined);
  };

  /*
   * A session on the Recorder's running worker, found afresh for every call. A stopped service
   * worker does not end a session attached to it this way (no detach arrives) and a message sent to
   * it then is never answered, so whether the worker is running is asked of the browser each time,
   * and a worker that was gone, even briefly, gets a new session.
   */
  const attach = async (): Promise<string> => {
    const running = await findWorker();
    if (running && attached?.targetId === running.targetId)
      return attached.sessionId;
    drop();
    const target = running ?? (await workerTarget());
    const { sessionId } = (await session.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    })) as { sessionId: string };
    attached = { targetId: target.targetId, sessionId };
    // A worker that started while something held it at its first line runs on from here. Nothing
    // waits on the answer, which the listener above ignores.
    await session.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id: ++nextId,
        method: "Runtime.runIfWaitingForDebugger",
      }),
    });
    return sessionId;
  };

  const sessionId = async (): Promise<string> => {
    attaching ??= attach().finally(() => {
      attaching = undefined;
    });
    return attaching;
  };

  /*
   * One message to the worker and its answer, within `timeoutMs` from start to finish: finding and
   * attaching to the worker, handing the message over, and the answer.
   *
   * NOTHING HERE MAY REJECT WITH NOBODY LISTENING. The timer used to start before the message was
   * handed over and was raced only after, so a browser slow to take the message fired it with
   * nothing awaiting it: an unhandled rejection, which ends a Bun process, and with it every
   * browser on this computer. Seen on a hosted computer while the Recorder recorded a burst of
   * input, when handing over a 2 s readiness check took longer than 2 s. So the whole exchange is
   * raced against the timer from the start, and the answer, which a stopped worker can reject while
   * the message is still being handed over, is marked as handled the moment it exists. Neither can
   * reject unheard, and the call ends in an answer or a refusal, never in the process ending.
   */
  const send = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> => {
    const id = ++nextId;
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new RecorderUnavailableError("The Recorder did not answer in time."),
        );
      }, timeoutMs);
    });
    const exchange = async (): Promise<unknown> => {
      const target = await sessionId();
      // A call that has already been refused sends nothing: its answer would have nowhere to go.
      if (over) throw new RecorderUnavailableError(WORKER_STOPPED);
      const answer = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      answer.catch(() => undefined);
      try {
        await session.send("Target.sendMessageToTarget", {
          sessionId: target,
          message: JSON.stringify({ id, method, params }),
        });
      } catch {
        // The session went with a worker that stopped before its detach was reported.
        if (attached?.sessionId === target) drop();
        throw new RecorderUnavailableError(WORKER_STOPPED);
      }
      return answer;
    };
    try {
      return await Promise.race([exchange(), late]);
    } finally {
      over = true;
      clearTimeout(timer);
      pending.delete(id);
    }
  };

  const evaluate = async (
    expression: string,
    timeoutMs: number,
  ): Promise<unknown> => {
    const result = (await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };
    if (result.exceptionDetails)
      throw new RecorderUnavailableError(
        `The Recorder failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown error"}`,
      );
    return result.result?.value;
  };

  const launcher = `globalThis[${JSON.stringify(LAUNCHER_GLOBAL)}]`;

  /**
   * Wait for the launcher, which a worker that has only just started may not have defined yet. A
   * worker that does not answer at all in that time is attached to afresh on the next try.
   */
  const ready = async (): Promise<void> => {
    const deadline = Date.now() + WORKER_START_MS;
    for (;;) {
      const defined = await evaluate(
        `typeof ${launcher}?.state === "function"`,
        READY_MS,
      ).catch((error: unknown) => {
        if (Date.now() > deadline) throw error;
        drop();
        return false;
      });
      if (defined === true) return;
      if (Date.now() > deadline)
        throw new RecorderUnavailableError(
          "The Recorder in this browser does not offer its launcher, so OpenBot cannot connect it.",
        );
      await sleep(POLL_MS);
    }
  };

  const call = async (
    method: keyof LauncherApi,
    argument?: unknown,
    timeoutMs = CALL_MS,
  ): Promise<unknown> => {
    // Once more if the worker stopped between finding it and calling it.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await ready();
        // The argument as JSON, which is a JavaScript expression of the same value.
        return await evaluate(
          `${launcher}.${method}(${argument === undefined ? "" : JSON.stringify(argument)})`,
          timeoutMs,
        );
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof RecorderUnavailableError) ||
          error.message !== WORKER_STOPPED
        )
          throw error;
      }
    }
  };

  const result = <T>(value: unknown): LauncherResult<T> => {
    if (value && typeof value === "object" && "ok" in value)
      return value as LauncherResult<T>;
    throw new RecorderUnavailableError(
      "The Recorder answered with something other than a launcher result.",
    );
  };

  return {
    async connect(argument) {
      return result(await call("connect", argument));
    },
    async record(argument) {
      return result<{ state: LauncherState }>(await call("record", argument));
    },
    async narrate(argument) {
      return result(await call("narrate", argument));
    },
    async speaking(argument) {
      return result(await call("speaking", argument));
    },
    async disconnect() {
      return result(await call("disconnect"));
    },
    /*
     * Read through the worker's own debugger: enabling it reports every script the worker has parsed,
     * each before the answer to the enable, and the source of the one asked for is then read by its
     * id. After `ready`, so the worker's script has run and is among them.
     */
    async workerSource(url) {
      await ready();
      const parsed = new Map<string, string>();
      const listener = (event: WorkerEvent) => {
        if (event.method !== "Debugger.scriptParsed") return;
        const script = event.params as { scriptId?: string; url?: string };
        if (script.url && script.scriptId)
          parsed.set(script.url, script.scriptId);
      };
      listeners.add(listener);
      try {
        await send("Debugger.enable", {}, CALL_MS);
        const scriptId = parsed.get(url);
        if (!scriptId) return undefined;
        const { scriptSource } = (await send(
          "Debugger.getScriptSource",
          { scriptId },
          CALL_MS,
        )) as { scriptSource?: string };
        return scriptSource;
      } finally {
        listeners.delete(listener);
        await send("Debugger.disable", {}, CALL_MS).catch(() => undefined);
      }
    },
    async state() {
      const value = await call("state", undefined, 5_000);
      if (!value || typeof value !== "object" || !("phase" in value))
        throw new RecorderUnavailableError(
          "The Recorder answered with something other than its state.",
        );
      return value as LauncherState;
    },
  };
}
