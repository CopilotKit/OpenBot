/**
 * The watch on a Bot's own stream, and what happens when it stops saying anything.
 *
 * A Bot is any AG-UI endpoint, which makes it infrastructure this deployment does not run: it will
 * be redeployed mid-run, its upstream will time out, it will accept a connection and then write
 * nothing. None of that is exceptional. What was missing was anybody noticing: an open stream that
 * never produces another byte leaves the channel busy, the composer locked and a person watching a
 * Bot that appears to be thinking and is not.
 *
 * The seam is the Bot's own HTTP response, wrapped on the way in. In Intelligence mode this server's
 * reply to the browser is a JSON envelope, not a stream, and the AG-UI events reach the browser over
 * a WebSocket to the gateway (see the module comment on turn-watchdog.ts for what was measured).
 * The Bot's response, however, is an ordinary streaming HTTP body that this process reads to the
 * end, so it is both the thing that stalls and the only place a stall can be seen.
 *
 * A PASS-THROUGH TRANSFORM IS THE ONLY ACCEPTABLE SHAPE HERE, and the transform below does exactly
 * one thing besides handing the chunk on. It must not buffer, because a Bot's answer is streamed a
 * token at a time and holding chunks back to inspect them would turn a live answer into a paragraph
 * that lands all at once. It must not await anything, because a chunk delayed here is a chunk
 * delayed on somebody's screen. And it must not decide anything about the bytes, because the moment
 * it parses them it can be wrong about them, and a watchdog that can misread a working run into a
 * broken one is worse than the failure it was added for. Counting is the whole of its job.
 *
 * On a stall it writes one RUN_ERROR event into the same stream and closes it. RUN_ERROR is the
 * event both surfaces already understand: the channel renders it through the subscriber it already
 * has, and the packaged chat shows its message in its own banner, so nothing downstream needs to
 * learn a new event to tell somebody what happened. AG-UI permits RUN_ERROR at any point in a
 * stream, including as the very first event, which is what a Bot that never spoke produces.
 */
import { type AuditStore, recordAuditEvent } from "../audit";
import { type StalledStream, TurnWatchdog } from "./turn-watchdog";

/** The fetch an `HttpAgent` uses, as @ag-ui/client 0.0.57 declares it. */
export type AgentFetch = (
  url: string,
  requestInit: RequestInit,
) => Promise<Response>;

/** Which Bot a watched stream belongs to. The name is for the sentence a person reads. */
export type WatchedBot = { id: string; name: string };

export type StallGuardOptions = {
  /** Silence this long ends the turn. Zero or less leaves every stream untouched. */
  stallMs: number;
  /** Absent leaves the trail without stall rows; the recovery still happens. */
  auditStore?: AuditStore;
  now?: () => number;
};

export type StallGuard = {
  /**
   * Wrap a fetch so that every stream it opens for this Bot is watched.
   *
   * Returns the fetch it was given, unchanged, when the watchdog is off. A deployment that has not
   * configured a timeout gets the code path it had before this existed, rather than a wrapper that
   * happens never to fire.
   */
  watch: (bot: WatchedBot, fetchImplementation?: AgentFetch) => AgentFetch;
  /** Stop sweeping. For orderly shutdown and for tests that must not leave a timer behind. */
  stop: () => void;
};

/**
 * Only a stream that says it is server-sent events gets an event written into it.
 *
 * This is deliberately stricter than the AG-UI client's own rule, which treats every content type
 * except the protobuf one as SSE. Being stricter fails in the safe direction: a Bot answering in a
 * framing this does not recognise gets a clean close and the run ends with the client's own terminal
 * event, which is a worse message than ours but is still an ending. Guessing the other way would
 * mean writing SSE bytes into a binary stream and corrupting a run that was merely slow.
 */
const SSE_CONTENT_TYPE = "text/event-stream";

const ENCODER = new TextEncoder();

/**
 * How often to look, derived from the deadline rather than fixed.
 *
 * A quarter of the timeout means a stall is reported within a quarter of the deadline of it
 * happening, which is proportionate: nobody watching a two-minute limit cares about thirty seconds
 * of reporting lag, and nobody testing a sixty-millisecond limit can wait a second for it. Bounded
 * at both ends so a very long timeout still sweeps every second and a very short one does not spin.
 */
function sweepIntervalFor(stallMs: number): number {
  return Math.min(1_000, Math.max(50, Math.floor(stallMs / 4)));
}

/** What one watched stream needs in order to be ended from outside it. */
type OpenStream = {
  bot: WatchedBot;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Cancels the Bot's side, so a wedged endpoint does not keep a socket here forever. */
  cancelUpstream: () => void;
  /** Whether an event may be written into this stream. See SSE_CONTENT_TYPE. */
  sse: boolean;
  /**
   * The request body, held as the string it was already serialised to.
   *
   * Read only when a stall has to name the turn it ended, so the thread and run identifiers cost a
   * JSON parse on the rare path rather than on every run. Nothing else in the request is wanted, and
   * nothing from it is recorded beyond those two ids.
   */
  requestBody: string | null;
  /** Set by whichever of the pump or the stall gets there first. */
  finished: boolean;
};

export function createStallGuard(options: StallGuardOptions): StallGuard {
  const streams = new Map<string, OpenStream>();
  const sweepEveryMs = sweepIntervalFor(options.stallMs);
  let sweeper: ReturnType<typeof setInterval> | undefined;

  const watchdog = new TurnWatchdog({
    stallMs: options.stallMs,
    ...(options.now ? { now: options.now } : {}),
    onStall: (stalled) => {
      void giveUp(stalled);
    },
  });

  /**
   * The sweep runs only while something is being watched.
   *
   * An idle deployment therefore holds no timer at all, and the one it holds while a Bot is
   * answering is unreferenced, so it can never be the reason a process refuses to exit.
   */
  function arm(): void {
    if (sweeper !== undefined) return;
    sweeper = setInterval(() => {
      watchdog.sweep();
      if (watchdog.watching === 0) disarm();
    }, sweepEveryMs);
    sweeper.unref();
  }

  function disarm(): void {
    if (sweeper === undefined) return;
    clearInterval(sweeper);
    sweeper = undefined;
  }

  /**
   * Take a stream off the watch, exactly once.
   *
   * Both the pump and the stall want to be the one that finishes a stream, and which of them gets
   * there first depends on timing nobody controls. Returning the stream only to the first caller is
   * what stops a stalled stream also being closed by its own pump a moment later, and stops a
   * cancelled read being reported as a stall.
   */
  function release(id: string): OpenStream | undefined {
    const stream = streams.get(id);
    if (!stream || stream.finished) return undefined;
    stream.finished = true;
    streams.delete(id);
    watchdog.close(id);
    return stream;
  }

  /**
   * End a turn whose Bot has stopped talking.
   *
   * The row is written before the stream is touched. A wedged Bot may also have a consumer that has
   * stopped reading, in which case the writes below never settle, and the record of what happened
   * must not depend on a promise that a broken stream owes us.
   */
  async function giveUp(stalled: StalledStream): Promise<void> {
    const stream = release(stalled.id);
    if (!stream) return;

    const turn = turnOf(stream.requestBody);
    console.error(
      JSON.stringify({
        type: "agent-stream-stalled",
        bot: stream.bot.id,
        silentForMs: stalled.silentForMs,
        chunks: stalled.chunks,
        ...(turn ? { thread: turn.threadId, run: turn.runId } : {}),
        note: "The Bot's stream produced nothing for the configured timeout, so the turn was ended.",
      }),
    );

    if (options.auditStore) {
      await recordAuditEvent(options.auditStore, {
        eventType: "agent.stream_stalled",
        targetType: "agent",
        targetId: stream.bot.id,
        payload: {
          bot: stream.bot.id,
          silentForMs: stalled.silentForMs,
          // Chunks, not events. One chunk can carry several AG-UI events and the boundaries are the
          // network's, so saying "events" here would be a number that looks precise and is not. Zero
          // is the fact worth reading: the Bot answered the request and then said nothing at all.
          chunks: stalled.chunks,
          ...(turn ? { thread: turn.threadId, run: turn.runId } : {}),
        },
      }).catch(() => undefined);
    }

    // The Bot's side goes first, so a socket into an endpoint that will never answer is released
    // whatever the browser's side of the stream is doing.
    stream.cancelUpstream();

    if (stream.sse) {
      // Deliberately not awaited: see the note above about a consumer that has stopped reading. The
      // write is queued ahead of the close, so it either lands in order or neither does.
      void stream.writer
        .write(stalledEvent(stream.bot.name, options.stallMs))
        .catch(() => undefined);
    }
    void stream.writer.close().catch(() => undefined);
  }

  function watch(
    bot: WatchedBot,
    fetchImplementation?: AgentFetch,
  ): AgentFetch {
    const inner: AgentFetch =
      fetchImplementation ?? ((url, requestInit) => fetch(url, requestInit));
    if (!watchdog.enabled) return inner;

    return async (url, requestInit) => {
      const response = await inner(url, requestInit);
      const body = response.body;
      // A refusal or an empty body is not a stream and has already ended. Passing it through
      // untouched keeps every error path exactly as it was, which is the point of the pass-through.
      if (!response.ok || body === null) return response;

      const id = crypto.randomUUID();
      const relay = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          watchdog.record(id);
          controller.enqueue(chunk);
        },
      });
      const reader = body.getReader();
      const writer = relay.writable.getWriter();

      streams.set(id, {
        bot,
        writer,
        cancelUpstream: () => {
          void reader.cancel().catch(() => undefined);
        },
        sse: (response.headers.get("content-type") ?? "").includes(
          SSE_CONTENT_TYPE,
        ),
        requestBody:
          typeof requestInit.body === "string" ? requestInit.body : null,
        finished: false,
      });
      watchdog.open({ id, botId: bot.id });
      arm();

      void pump(id, reader, writer);

      // The same response, with the body replaced. Status and headers are carried over because the
      // AG-UI client reads the content type off this response to choose its parser.
      return new Response(relay.readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }

  /**
   * Move bytes across, and end the stream the way the Bot ended it.
   *
   * A read that throws is passed on as an abort rather than as a clean close. A broken connection
   * carries a real reason, and relabelling it as an ending would file a transport failure as a Bot
   * that merely stopped, which is exactly the distinction this file exists to be able to draw.
   */
  async function pump(
    id: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      if (release(id)) await writer.close().catch(() => undefined);
    } catch (error) {
      if (release(id)) await writer.abort(error).catch(() => undefined);
    }
  }

  return {
    watch,
    stop: disarm,
  };
}

/**
 * The turn, read from the request the stalled stream was answering.
 *
 * Returns null rather than throwing for anything unexpected. A stall is already a failure, and a
 * malformed body is no reason to lose the row that records it; the Bot is named either way, and the
 * Bot is what a deployment counts these by.
 */
function turnOf(
  body: string | null,
): { threadId: string; runId: string } | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    const { threadId, runId } = parsed as {
      threadId?: unknown;
      runId?: unknown;
    };
    return typeof threadId === "string" && typeof runId === "string"
      ? { threadId, runId }
      : null;
  } catch {
    return null;
  }
}

/**
 * The one event a stalled stream gets, as a server-sent event.
 *
 * Written by hand rather than through an encoder because the framing is two lines and adding a
 * dependency to produce them would be the larger change. The AG-UI client parses `data:` lines as
 * JSON and validates them against its own schemas, so this is the same shape a Bot would have sent.
 *
 * The wording avoids " - " and a trailing three-digit number. The packaged chat's banner truncates a
 * message at the first of those and strips the second, so a sentence containing either arrives at a
 * person cut in half.
 */
function stalledEvent(botName: string, stallMs: number): Uint8Array {
  const event = {
    type: "RUN_ERROR",
    message:
      `${botName} stopped responding. Nothing arrived from it for ${inWords(stallMs)}, ` +
      "so this turn was ended. Ask again, or check that the Bot is running.",
    code: "AGENT_STREAM_STALLED",
  };
  return ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * The timeout as a person would say it, because the sentence above is read by one.
 *
 * Floored at a second. A timeout below one is only ever a test's, and "nothing arrived from it for
 * 0 seconds" is a sentence that makes a reader doubt everything else on the screen.
 */
function inWords(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "a minute" : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return seconds === 1 ? "a second" : `${seconds} seconds`;
}
