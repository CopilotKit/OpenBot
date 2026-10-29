// Real Chrome's CDP traffic, replayed into the chrome fake. Each fixture under tests/fixtures/agui is what Chrome 156 sent
// over CDP while a real page ran a real agent (its description says which), recorded with the Recorder's own reads: the
// Network domain enabled with a 64 KiB maxPostDataSize, Network.streamResourceContent at an event stream's
// responseReceived, Network.getRequestPostData for a body left out of requestWillBeSent, Network.getResponseBody at
// loadingFinished. The replay sends the events in Chrome's order and answers each command the capture sends with
// Chrome's own answer, at the point in the sequence Chrome gave it, so the fake does what Chrome did.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChromeFake } from "./chrome-fake";

export type FixtureEvent = {
  kind: "event";
  t: number;
  session: string;
  method: string;
  params: Record<string, unknown> & { requestId?: string };
};
export type FixtureCommand = {
  kind: "command";
  t: number;
  tEnd: number;
  session: string;
  method: string;
  params: { requestId: string };
  result?: Record<string, unknown>;
  error?: string;
};
export type FixtureMark = {
  kind: "mark";
  t: number;
  /** Date.now() on the recording machine, the clock Chrome's wallTime also reads. */
  wall: number;
  name: string;
  data?: Record<string, unknown>;
};
export type FixtureEntry = FixtureEvent | FixtureCommand | FixtureMark;
export type Fixture = {
  description: string;
  browser: string;
  entries: FixtureEntry[];
};

const fixtures = new Map<string, Fixture>();

export function loadFixture(name: string): Fixture {
  const known = fixtures.get(name);
  if (known) return known;
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "fixtures", "agui", `${name}.json`),
      "utf8",
    ),
  ) as Fixture;
  fixtures.set(name, fixture);
  return fixture;
}

export const events = (fixture: Fixture, method?: string): FixtureEvent[] =>
  fixture.entries.filter(
    (entry): entry is FixtureEvent =>
      entry.kind === "event" &&
      (method === undefined || entry.method === method),
  );

export const marks = (fixture: Fixture, name?: string): FixtureMark[] =>
  fixture.entries.filter(
    (entry): entry is FixtureMark =>
      entry.kind === "mark" && (name === undefined || entry.name === name),
  );

/** The recorded requests the page sent, by request id. */
export function requests(
  fixture: Fixture,
): Map<string, FixtureEvent["params"] & { request: Record<string, unknown> }> {
  const out = new Map();
  for (const entry of events(fixture, "Network.requestWillBeSent"))
    out.set(entry.params.requestId, entry.params);
  return out;
}

const base64Bytes = (base64: string) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** The bytes of one response as the page received them: what streamResourceContent had buffered, then every chunk a
 * dataReceived carried, or, for one that never streamed, the body getResponseBody read whole. */
export function responseBytes(fixture: Fixture, requestId: string): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of fixture.entries) {
    if (entry.kind === "command" && entry.params.requestId === requestId) {
      if (
        entry.method === "Network.streamResourceContent" &&
        typeof entry.result?.bufferedData === "string"
      )
        parts.push(base64Bytes(entry.result.bufferedData));
      if (
        entry.method === "Network.getResponseBody" &&
        typeof entry.result?.body === "string" &&
        parts.length === 0
      )
        parts.push(
          entry.result.base64Encoded === true
            ? base64Bytes(entry.result.body)
            : new TextEncoder().encode(entry.result.body),
        );
    }
    if (
      entry.kind === "event" &&
      entry.method === "Network.dataReceived" &&
      entry.params.requestId === requestId &&
      typeof entry.params.data === "string"
    )
      parts.push(base64Bytes(entry.params.data));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** The chunks one response arrived in, each with its time in the recording (ms), for a server to send the same way. */
export function responseChunks(
  fixture: Fixture,
  requestId: string,
): { t: number; bytes: Uint8Array }[] {
  const chunks: { t: number; bytes: Uint8Array }[] = [];
  for (const entry of fixture.entries) {
    if (
      entry.kind === "command" &&
      entry.params.requestId === requestId &&
      entry.method === "Network.streamResourceContent" &&
      typeof entry.result?.bufferedData === "string" &&
      entry.result.bufferedData !== ""
    )
      chunks.push({
        t: entry.t,
        bytes: base64Bytes(entry.result.bufferedData),
      });
    if (
      entry.kind === "event" &&
      entry.method === "Network.dataReceived" &&
      entry.params.requestId === requestId &&
      typeof entry.params.data === "string"
    )
      chunks.push({ t: entry.t, bytes: base64Bytes(entry.params.data) });
  }
  if (chunks.length === 0) {
    const whole = responseBytes(fixture, requestId);
    if (whole.length > 0) chunks.push({ t: 0, bytes: whole });
  }
  return chunks;
}

/** Recorded time (ms from the recording's start) to the recording machine's wall clock. */
export function wallClock(fixture: Fixture): (t: number) => number {
  const mark = marks(fixture)[0];
  if (!mark) throw new Error("A fixture with no mark has no wall clock");
  return (t) => Math.round(mark.wall + (t - mark.t));
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export type Replay = {
  /** Plays the entries up to and including the first one `stop` accepts (all of them without one). `speed` plays
   * them that many times faster than real time (1: as fast as Chrome sent them); without it they play as fast as the
   * capture keeps up, a few turns of the event loop between Chrome's messages. */
  run(stop?: (entry: FixtureEntry) => boolean, speed?: number): Promise<void>;
  /** The wall clock at the recording's position, so a step or a clock in the test reads the time the page lived. */
  now(): number;
};

/**
 * Replays `fixture` into the chrome fake as tab `tabId` (the page's own session is the tab; a frame's session keeps its
 * id). `onMark` sees each mark (a click, typing) as the recording reaches it.
 */
export function replay(
  fake: ChromeFake,
  tabId: number,
  fixture: Fixture,
  options: { onMark?(mark: FixtureMark): void } = {},
): Replay {
  const wall = wallClock(fixture);
  const commands = fixture.entries.filter(
    (entry): entry is FixtureCommand => entry.kind === "command",
  );
  let position = fixture.entries[0]?.t ?? 0;
  let paced: { start: number; from: number; speed: number } | null = null;
  const waiting: { at: number; resolve(): void }[] = [];
  const release = () => {
    for (const waiter of [...waiting])
      if (waiter.at <= position) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve();
      }
  };
  const target = (session: string) =>
    session === "page" ? { tabId } : { tabId, sessionId: session };

  for (const method of [
    "Network.streamResourceContent",
    "Network.getResponseBody",
    "Network.getRequestPostData",
  ])
    fake.debugger.respond(method, (params) => {
      const requestId = (params as { requestId: string }).requestId;
      const recorded = commands.find(
        (command) =>
          command.method === method && command.params.requestId === requestId,
      );
      if (!recorded)
        // What Chrome answers for a resource it does not hold.
        throw new Error("No resource with given identifier found");
      const answer = () => {
        if (recorded.error !== undefined) throw new Error(recorded.error);
        return recorded.result ?? {};
      };
      if (recorded.tEnd <= position) return answer();
      return new Promise<void>((resolve) =>
        waiting.push({ at: recorded.tEnd, resolve }),
      ).then(answer) as unknown as object;
    });

  let next = 0;
  return {
    async run(stop, speed) {
      paced = null;
      while (next < fixture.entries.length) {
        const entry = fixture.entries[next++];
        if (!entry) break;
        if (speed) {
          paced ??= { start: performance.now(), from: position, speed };
          const due = paced.start + (entry.t - paced.from) / speed;
          const wait = due - performance.now();
          if (wait > 0)
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        position = entry.t;
        release();
        await tick();
        if (entry.kind === "event")
          fake.debugger.emit(target(entry.session), entry.method, entry.params);
        else if (entry.kind === "mark") options.onMark?.(entry);
        await tick();
        if (stop?.(entry)) break;
      }
      if (next >= fixture.entries.length) {
        position = Number.POSITIVE_INFINITY;
        release();
      }
      for (let i = 0; i < 5; i++) await tick();
    },
    now() {
      if (!paced) return wall(position);
      return wall(paced.from + (performance.now() - paced.start) * paced.speed);
    },
  };
}
