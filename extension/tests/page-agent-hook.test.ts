// The page hook's side of AG-UI, when Chrome refuses the debugger: the same traffic real Chrome recorded (tests/fixtures/
// agui), served again byte for byte, chunk by chunk, by a local server to the page's own fetch and WebSocket, must give
// the agent events the same observations the debugger capture gives from the CDP of that traffic, and the page must get
// its responses and sockets untouched.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CaptureObservation } from "../src/background/agent/observation";
import { createNetworkCapture } from "../src/background/network";
import type { PageObservation } from "../src/shared/agui";
import {
  type Fixture,
  loadFixture,
  marks,
  replay,
  responseChunks,
} from "./support/cdp-replay";
import { installChromeFake } from "./support/chrome-fake";

// Bun.serve, fetch and WebSocket are the runtime's own: happy-dom's registration replaces them on globalThis.
const NativeResponse = Response;
const nativeFetch = fetch;
const NativeWebSocket = WebSocket;
const NativeAbortController = AbortController;

type Json = Record<string, unknown>;
type Sent = {
  id: string;
  message: { type: string; observation?: PageObservation; event?: Json };
};

/** What one recorded fixture asks the server to answer: each request by method, path and body, and each socket by path. */
type HttpAnswer = {
  status: number;
  contentType: string;
  chunks: Uint8Array[];
  /** The page stopped this one: its answer never ends. */
  aborted: boolean;
};
type SocketScript = {
  /** In recorded order: what the page sent, and what the socket received. */
  frames: { sent: boolean; data: string }[];
  closed: boolean;
};

let server: ReturnType<typeof Bun.serve<{ path: string }, never>>;
let answers = new Map<string, HttpAnswer[]>();
let scripts = new Map<string, SocketScript[]>();
let sent: Sent[] = [];

const requestKey = (method: string, path: string, body: string) =>
  `${method} ${path} ${body}`;

beforeAll(() => {
  server = Bun.serve<{ path: string }, never>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      if (srv.upgrade(request, { data: { path } })) return;
      const body = request.method === "GET" ? "" : await request.text();
      const answer = answers
        .get(requestKey(request.method, path, body))
        ?.shift();
      if (!answer) return new NativeResponse("not recorded", { status: 404 });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of answer.chunks) {
            controller.enqueue(chunk);
            await Bun.sleep(1);
          }
          if (!answer.aborted) controller.close();
        },
      });
      return new NativeResponse(stream, {
        status: answer.status,
        headers: { "content-type": answer.contentType },
      });
    },
    websocket: {
      open(ws) {
        const script = scripts.get(ws.data.path)?.[0];
        if (!script) return;
        // What the socket received before the page sent anything.
        while (script.frames[0] && !script.frames[0].sent)
          ws.send(script.frames.shift()?.data ?? "");
      },
      message(ws) {
        const script = scripts.get(ws.data.path)?.[0];
        if (!script) return;
        script.frames.shift();
        while (script.frames[0] && !script.frames[0].sent)
          ws.send(script.frames.shift()?.data ?? "");
        if (script.frames.length === 0) {
          scripts.get(ws.data.path)?.shift();
          if (script.closed) ws.close(1000, "recorded");
        }
      },
    },
  });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${server.port}/page` });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  await server.stop(true);
});

const hookKey = (name: "configure" | "stop") =>
  Symbol.for(`openbot.recorder.${name}`);
const globals = globalThis as unknown as Record<symbol, unknown>;
const configure = (id: string) =>
  (globals[hookKey("configure")] as (id: string) => void)(id);
const stop = () => (globals[hookKey("stop")] as () => void)();

beforeEach(async () => {
  sent = [];
  answers = new Map();
  scripts = new Map();
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = NativeWebSocket;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (id: string, message: Sent["message"]) => {
        sent.push({ id, message });
        return Promise.resolve();
      },
    },
  };
  await import(`../src/main-world/network-hook.ts?run=${crypto.randomUUID()}`);
});
afterEach(() => {
  stop();
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = NativeWebSocket;
  delete (globalThis as { chrome?: unknown }).chrome;
  delete globals[hookKey("configure")];
  delete globals[hookKey("stop")];
});

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** The OpenBot a recording of OpenBot's own page is connected to: the page's origin. The page hook knows nothing of
 * OpenBot, and the debugger capture follows only OpenBot's chat and its runtime's `info`, so the two still agree. */
const openbotOf = (fixture: Fixture): string | null =>
  fixture === loadFixture("openbot-chat")
    ? new URL(String(marks(fixture, "navigate")[0]?.data?.url)).origin
    : null;

/** The observations the debugger capture makes from the fixture's CDP. */
async function debuggerObservations(
  fixture: Fixture,
): Promise<CaptureObservation[]> {
  const page = (globalThis as { chrome?: unknown }).chrome;
  const fake = installChromeFake({ extensionId: "test" });
  const observations: CaptureObservation[] = [];
  const capture = createNetworkCapture(
    {
      openbotUrl: () => openbotOf(fixture),
      call: () => {},
      writeStarted: () => {},
      writeEnded: () => {},
      status: () => {},
      digests: () => new Set(),
      agent: (observation) => observations.push(observation),
    },
    {},
  );
  try {
    await capture.start(7, String(marks(fixture, "navigate")[0]?.data?.url));
    await replay(fake, 7, fixture).run();
  } finally {
    await capture.stop();
    fake.uninstall();
    (globalThis as { chrome?: unknown }).chrome = page;
  }
  return observations;
}

type Recorded = {
  kind: "fetch" | "socket";
  id: string;
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  /** A fetch's recorded answer. */
  answer?: HttpAnswer;
};

/** What the page did, in order: each fetch it made (the page's own requests, never a script or a document) and each
 * socket it opened, with what the server is to answer. */
function plan(fixture: Fixture): Recorded[] {
  const order: Recorded[] = [];
  const failed = new Set<string>();
  const status = new Map<string, { status: number; type: string }>();
  for (const entry of fixture.entries) {
    if (entry.kind !== "event") continue;
    const params = entry.params as Json & { requestId: string };
    if (entry.method === "Network.loadingFailed") failed.add(params.requestId);
    if (entry.method === "Network.responseReceived") {
      const response = params.response as { status: number; mimeType: string };
      status.set(params.requestId, {
        status: response.status,
        type: response.mimeType,
      });
    }
  }
  const postData = (id: string) => {
    for (const entry of fixture.entries)
      if (
        entry.kind === "command" &&
        entry.method === "Network.getRequestPostData" &&
        entry.params.requestId === id
      )
        return entry.result?.postData as string | undefined;
    return undefined;
  };
  for (const entry of fixture.entries) {
    if (entry.kind !== "event") continue;
    const params = entry.params as Json & { requestId: string };
    if (
      entry.method === "Network.requestWillBeSent" &&
      params.type === "Fetch"
    ) {
      const request = params.request as {
        url: string;
        method: string;
        headers: Record<string, string>;
        postData?: string;
      };
      const body =
        request.method === "GET"
          ? undefined
          : (request.postData ?? postData(params.requestId) ?? "");
      const answer = status.get(params.requestId);
      if (!answer) continue;
      const key = requestKey(request.method, pathOf(request.url), body ?? "");
      const recorded: HttpAnswer = {
        status: answer.status,
        contentType: answer.type,
        chunks: responseChunks(fixture, params.requestId).map(
          ({ bytes }) => bytes,
        ),
        aborted: failed.has(params.requestId),
      };
      answers.set(key, [...(answers.get(key) ?? []), recorded]);
      order.push({
        answer: recorded,
        kind: "fetch",
        id: params.requestId,
        url: request.url,
        method: request.method,
        ...(body !== undefined ? { body } : {}),
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([name]) =>
            /^(content-type|accept)$/i.test(name),
          ),
        ),
      });
    }
    if (entry.method === "Network.webSocketCreated") {
      const url = String(params.url);
      const frames: SocketScript["frames"] = [];
      let closed = false;
      for (const other of fixture.entries) {
        if (
          other.kind !== "event" ||
          other.params.requestId !== params.requestId
        )
          continue;
        if (
          other.method === "Network.webSocketFrameSent" ||
          other.method === "Network.webSocketFrameReceived"
        )
          frames.push({
            sent: other.method === "Network.webSocketFrameSent",
            data: (other.params.response as { payloadData: string })
              .payloadData,
          });
        if (other.method === "Network.webSocketClosed") closed = true;
      }
      const path = pathOf(url.replace(/^ws/, "http"));
      scripts.set(path, [...(scripts.get(path) ?? []), { frames, closed }]);
      order.push({
        kind: "socket",
        id: params.requestId,
        url,
        method: "GET",
        headers: {},
      });
    }
  }
  return order;
}

/** Plays the page's side against the server: each fetch read to its end (one the page stopped, aborted once its
 * recorded bytes came), each socket sending what the page sent once the socket had received what came before it. */
async function playPage(steps: Recorded[]) {
  const scriptsBefore = new Map(
    [...scripts].map(([path, list]) => [
      path,
      list.map((script) => [...script.frames]),
    ]),
  );
  const opened: WebSocket[] = [];
  const pageGot = new Map<string, Uint8Array>();
  for (const step of steps) {
    if (step.kind === "fetch") {
      const controller = new NativeAbortController();
      const path = pathOf(step.url);
      const answer = step.answer;
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: step.method,
        headers: step.headers,
        ...(step.body !== undefined ? { body: step.body } : {}),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      const expected =
        answer?.chunks.reduce((sum, chunk) => sum + chunk.length, 0) ?? 0;
      let received = 0;
      for (;;) {
        if (answer?.aborted && received >= expected) {
          controller.abort();
          break;
        }
        const read = await reader?.read().catch(() => undefined);
        if (!read?.value) break;
        parts.push(read.value);
        received += read.value.length;
      }
      const whole = new Uint8Array(received);
      let offset = 0;
      for (const part of parts) {
        whole.set(part, offset);
        offset += part.length;
      }
      pageGot.set(step.id, whole);
      continue;
    }
    const path = pathOf(step.url.replace(/^ws/, "http"));
    const frames = scriptsBefore.get(path)?.shift() ?? [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
    opened.push(socket);
    let received = 0;
    const done = new Promise<void>((resolve) => {
      let index = 0;
      const pump = () => {
        // Send what the page sent next, once everything recorded before it has arrived.
        while (index < frames.length) {
          const frame = frames[index];
          if (!frame) break;
          if (!frame.sent) {
            const before = frames
              .slice(0, index + 1)
              .filter((f) => !f.sent).length;
            if (received < before) return;
            index++;
            continue;
          }
          socket.send(frame.data);
          index++;
        }
        resolve();
      };
      socket.addEventListener("open", pump);
      socket.addEventListener("message", () => {
        received++;
        pump();
      });
      socket.addEventListener("close", () => resolve());
    });
    await Promise.race([done, Bun.sleep(3_000)]);
  }
  await Bun.sleep(50);
  for (const socket of opened)
    if (socket.readyState === NativeWebSocket.OPEN) socket.close();
  await Bun.sleep(50);
  return pageGot;
}

/** An observation as both captures should make it, without what differs by design: the tab and stream ids (each
 * capture names its own), when it saw it, and the server's address. The runtime's `info` answer is a stream of its
 * own. */
function signature(observations: (CaptureObservation | PageObservation)[]) {
  const streams = new Map<string, unknown[]>();
  for (const observation of observations) {
    const {
      streamId = "runtime",
      at: _at,
      ...rest
    } = observation as Json & { streamId?: string; at: number };
    const { tabId: _tab, ...kept } = rest as Json;
    const shown =
      kept.kind === "request" || kept.kind === "runtime"
        ? { ...kept, url: pathOf(String(kept.url)) }
        : kept;
    streams.set(streamId, [...(streams.get(streamId) ?? []), shown]);
  }
  return [...streams.values()].map((stream) => JSON.stringify(stream)).sort();
}

const pageObservations = () =>
  sent.flatMap(({ message }) =>
    message.type === "recorder.page-agent" && message.observation
      ? [message.observation]
      : [],
  );

/** The fixtures of a CopilotKit page: its runtime's `info` call is in their traffic (single route, REST, Intelligence). */
const COPILOTKIT_PAGES = new Map([
  ["single-route-sse", 1],
  ["rest-sse", 1],
  ["intelligence-websocket", 1],
  // OpenBot's own chat asks when it loads and again after the run.
  ["openbot-chat", 2],
]);

for (const name of [
  "single-route-sse",
  "rest-sse",
  "intelligence-websocket",
  "generic-proto-ws-ticker",
  "late-and-aborted",
  "openbot-chat",
])
  test(`the page hook gives the same observations as the debugger for the same traffic: ${name}`, async () => {
    const fixture = loadFixture(name);
    const expected = await debuggerObservations(fixture);
    const steps = plan(fixture);
    configure("extension-id");
    const recorded = new Map(
      steps
        .filter((step) => step.kind === "fetch")
        .map((step) => [step.id, step.answer] as const),
    );
    const pageGot = await playPage(steps);
    const observed = pageObservations();
    expect(observed.length).toBeGreaterThan(0);
    expect(signature(observed)).toEqual(signature(expected));
    for (const observation of observed) {
      expect(observation.at).toBeGreaterThan(0);
      if (observation.kind !== "runtime")
        expect(typeof observation.streamId).toBe("string");
    }
    // A CopilotKit page asked its runtime what it serves and the runtime answered: both captures say the page runs
    // CopilotKit, once; the other servers' pages never do.
    const runtimeAnswers = (list: (CaptureObservation | PageObservation)[]) =>
      list.filter((observation) => observation.kind === "runtime").length;
    expect(runtimeAnswers(expected)).toBe(COPILOTKIT_PAGES.get(name) ?? 0);
    expect(runtimeAnswers(observed)).toBe(runtimeAnswers(expected));
    // The page got every response untouched, byte for byte, read through to its end while the hook read its copy.
    for (const [id, answer] of recorded) {
      const bytes = answer?.chunks.reduce(
        (sum, chunk) => sum + chunk.length,
        0,
      );
      expect(pageGot.get(id)?.length).toBe(bytes);
    }
    // An agent run is never a network event, there as in the debugger's capture.
    for (const { message } of sent)
      if (message.type === "recorder.page-network")
        expect(JSON.stringify(message.event)).not.toContain("agent/run");
  });

test("the page's WebSocket stays the browser's own: instanceof, prototype, constants and subclassing, and stop puts it back", async () => {
  configure("extension-id");
  expect(globalThis.WebSocket).not.toBe(NativeWebSocket);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/nothing`);
  expect(socket instanceof WebSocket).toBe(true);
  expect(socket instanceof NativeWebSocket).toBe(true);
  expect(Object.getPrototypeOf(socket)).toBe(NativeWebSocket.prototype);
  expect(WebSocket.prototype).toBe(NativeWebSocket.prototype);
  expect([
    WebSocket.CONNECTING,
    WebSocket.OPEN,
    WebSocket.CLOSING,
    WebSocket.CLOSED,
  ]).toEqual([0, 1, 2, 3]);
  class Named extends WebSocket {
    name = "mine";
  }
  const named = new Named(`ws://127.0.0.1:${server.port}/nothing`);
  expect(named).toBeInstanceOf(Named);
  expect(named.name).toBe("mine");
  socket.close();
  named.close();
  stop();
  expect(globalThis.WebSocket).toBe(NativeWebSocket);
});

test("an event stream that is not AG-UI gives the agent events nothing, even answering a run-shaped POST, which stays a network event; the page reads it whole", async () => {
  const fixture = loadFixture("generic-proto-ws-ticker");
  const ticker = fixture.entries.find(
    (entry) =>
      entry.kind === "event" &&
      entry.method === "Network.requestWillBeSent" &&
      entry.params.type === "EventSource",
  );
  const chunks = responseChunks(
    fixture,
    String(ticker?.kind === "event" ? ticker.params.requestId : ""),
  ).map(({ bytes }) => bytes);
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  expect(chunks.length).toBeGreaterThan(1);
  const body = JSON.stringify({
    threadId: "t-1",
    runId: "r-1",
    messages: [{ id: "m-1", role: "user", content: "prices?" }],
  });
  const answer = (): HttpAnswer => ({
    status: 200,
    contentType: "text/event-stream",
    chunks,
    aborted: false,
  });
  answers.set(requestKey("GET", "/prices", ""), [answer()]);
  answers.set(requestKey("POST", "/prices", body), [answer()]);
  configure("extension-id");
  const read = async (response: Response) =>
    new Uint8Array(await response.arrayBuffer()).length;
  expect(
    await read(await fetch(`http://127.0.0.1:${server.port}/prices`)),
  ).toBe(length);
  expect(
    await read(
      await fetch(`http://127.0.0.1:${server.port}/prices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    ),
  ).toBe(length);
  await Bun.sleep(100);
  expect(pageObservations()).toEqual([]);
  expect(
    sent.filter(({ message }) => message.type === "recorder.page-network"),
  ).toHaveLength(2);
});
