/**
 * Whether a turn has gone quiet, which is not the same question as whether it has taken a long time.
 *
 * A turn may legitimately run for an hour. A Bot reading a long document, or a model writing slowly,
 * produces events the whole way and there is nothing wrong with it. A turn whose stream has produced
 * nothing at all for `stallMs` is wedged. Telling those apart by activity rather than by duration is
 * the whole design, and the difference matters: a duration limit puts a ceiling on how much work a
 * Bot is allowed to do, which nobody asked for, whereas a silence limit puts a ceiling on how long a
 * person is asked to watch a spinner, which is the actual complaint.
 *
 * WHAT THE STREAM ACTUALLY DOES IN THIS PRODUCT, measured before any of this was designed, because
 * the answer decides whether a long tool call would be reported as a stall.
 *
 * OpenBot runs in Intelligence mode and has no other mode, so `POST /api/copilotkit/agent/:id/run`
 * does not stream at all. It answers `Content-Type: application/json` with a fixed Content-Length in
 * about a second, carrying a join token, and the AG-UI events reach the browser over a WebSocket to
 * the Intelligence gateway. Wrapping that response body would watch a JSON envelope go past. The
 * stream that can actually stall is the one on the other side of this server: the Bot's own AG-UI
 * response, read here, event by event, and republished to the gateway. That is the stream this
 * watchdog is pointed at, and stall-guard.ts is where it is wrapped.
 *
 * The computer tools are frontend tools, executed in the browser, and the run ENDS before the
 * browser runs one. The Bot emits TOOL_CALL_START, ARGS and END and then RUN_FINISHED, its stream
 * closes, the browser executes the tool, and the CopilotKit client opens a SECOND run carrying the
 * result. Verified in @copilotkit/core 1.67.1, whose `processAgentResult` executes frontend tools
 * only after `agent.runAgent` has resolved and then re-enters `runAgent`, and against `agent-bot` in
 * this repository, which writes its tool calls followed by RUN_FINISHED and closes the stream.
 *
 * So no exemption for tool calls exists here, and none is needed. A browser tool that takes ten
 * minutes holds no stream open, because there is no stream open while it runs. An exemption would be
 * a hole in the only thing this watchdog does, opened for a case that does not occur.
 *
 * It holds no timer of its own. The clock is injected and `sweep` is called by whoever owns the
 * schedule, so a test can move time by a minute without waiting one, and so the decision about when
 * to look is made in one place rather than hidden in here.
 */

/** Milliseconds, from whatever source the caller trusts. Injected so tests need not sleep. */
export type Clock = () => number;

/** One stream under watch. */
export type WatchedStream = {
  /**
   * How the caller finds this stream again. Minted per stream rather than taken from the run,
   * because the id has to exist before the first byte arrives and the run identifiers are inside the
   * request the stream is answering.
   */
  id: string;
  /** The Bot on the far end, so a stall names what went quiet rather than which socket it was. */
  botId: string;
};

export type StalledStream = WatchedStream & {
  /** How long it had been silent when it was given up on. Never less than `stallMs`. */
  silentForMs: number;
  /** Chunks that arrived before the silence. Zero means the Bot never said anything at all. */
  chunks: number;
};

export type TurnWatchdogOptions = {
  /**
   * Silence this long means the stream is wedged.
   *
   * Zero, or anything below it, switches the watchdog off completely: `open` records nothing and
   * `sweep` has nothing to find. A deployment that has not asked for a watchdog gets the behaviour
   * it had before there was one, rather than a watchdog with a surprising number in it.
   */
  stallMs: number;
  /** Called once per stalled stream, after the stream has been taken off the watch. */
  onStall: (stream: StalledStream) => void;
  now?: Clock;
};

type OpenStream = WatchedStream & {
  lastChunkAt: number;
  chunks: number;
};

export class TurnWatchdog {
  private readonly stallMs: number;
  private readonly onStall: (stream: StalledStream) => void;
  private readonly now: Clock;
  private readonly streams = new Map<string, OpenStream>();

  constructor(options: TurnWatchdogOptions) {
    this.stallMs = options.stallMs;
    this.onStall = options.onStall;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether this deployment asked for a watchdog at all. */
  get enabled(): boolean {
    return this.stallMs > 0;
  }

  /** How many streams are currently being watched. */
  get watching(): number {
    return this.streams.size;
  }

  /**
   * Start watching a stream.
   *
   * The clock starts here rather than at the first chunk, so a Bot that accepts a connection and
   * then says nothing at all is caught by the same rule as one that stops halfway. That case is the
   * common one: an endpoint that has been redeployed answers the request and never writes.
   *
   * Opening an id that is already open restarts its clock rather than raising. A second open for the
   * same stream can only mean the caller believes it is alive, and the safe reading of that is to
   * believe them.
   */
  open(stream: WatchedStream): void {
    if (!this.enabled) return;
    this.streams.set(stream.id, {
      ...stream,
      lastChunkAt: this.now(),
      chunks: 0,
    });
  }

  /**
   * Note that something arrived.
   *
   * An id that is not being watched is ignored rather than started, and that is what makes the
   * callback fire exactly once per stream: `sweep` removes a stream as it reports it, so a chunk
   * that arrives from a Bot after it was given up on cannot quietly begin a second watch which would
   * stall again and report the same wedged turn twice.
   */
  record(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.lastChunkAt = this.now();
    stream.chunks += 1;
  }

  /** Stop watching. Unknown ids are ignored, so closing a stream that already stalled is harmless. */
  close(id: string): void {
    this.streams.delete(id);
  }

  /**
   * Report every stream that has gone quiet, and returns how many there were.
   *
   * Each one is removed before its callback runs, so a callback that throws still leaves the
   * watchdog consistent, and a slow callback cannot be entered twice for the same stream.
   */
  sweep(): number {
    if (!this.enabled) return 0;
    const now = this.now();
    let stalled = 0;

    for (const [id, stream] of this.streams) {
      const silentForMs = now - stream.lastChunkAt;
      if (silentForMs < this.stallMs) continue;

      this.streams.delete(id);
      stalled += 1;
      try {
        this.onStall({
          id,
          botId: stream.botId,
          silentForMs,
          chunks: stream.chunks,
        });
      } catch (error) {
        // One Bot's failure must not stop the others being closed. This is the same blast-radius
        // argument the process-level rejection handler in index.ts makes: a wedged Bot is somebody
        // else's infrastructure, and the sweep it happens to be in is holding every other person's
        // stuck turn. Logged loudly, because a watchdog that fails silently is worse than none.
        console.error(
          JSON.stringify({
            type: "turn-watchdog-callback-error",
            stream: id,
            bot: stream.botId,
            error: String(error),
          }),
        );
      }
    }

    return stalled;
  }
}
