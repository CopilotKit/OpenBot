// The AG-UI a page receives, as the debugger capture hands it to the agent events, replayed from what real Chrome sent
// over CDP while real CopilotKit pages ran a real agent (tests/fixtures/agui; support/cdp-replay.ts says how). Every
// stream is held to what CopilotKit's own client parsed from the same bytes (@ag-ui/client 1.0.2, phoenix.js).
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type {
  AgentObservation,
  AgentRuntimeInfo,
} from "../src/background/agent/observation";
import {
  createNetworkCapture,
  type NetworkCapture,
} from "../src/background/network";
import type { PageFallback } from "../src/background/network/fallback";
import {
  createStepAssembler,
  type StepAssembler,
  type StepCall,
} from "../src/background/steps";
import {
  AGUI_PROTO_TYPE,
  isRuntimeInfoAnswer,
  matchRuntimeInfoRequest,
} from "../src/shared/agui";
import { clientEvents, phoenixFrame } from "./support/agui-client";
import {
  events,
  type Fixture,
  type FixtureEntry,
  loadFixture,
  marks,
  type Replay,
  replay,
  requests,
  responseBytes,
} from "./support/cdp-replay";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

const TAB = 7;
const OPENBOT = "https://openbot.example.test";

let fake: ChromeFake;
let capture: NetworkCapture;
let observations: AgentObservation[] = [];
/** The page's CopilotKit runtime answering its `info` call. */
let runtimes: AgentRuntimeInfo[] = [];
let calls: StepCall[] = [];
let started: string[] = [];
let steps: StepAssembler | null = null;
/** The OpenBot the recording is connected to: a test recording OpenBot's own page names it. */
let openbot = OPENBOT;

const fallback: PageFallback = {
  start: async () => false,
  addTab: async () => {},
  onCommitted: async () => {},
  stop: async () => {},
  active: () => false,
};

beforeEach(() => {
  fake = installChromeFake({ extensionId: "test" });
  observations = [];
  runtimes = [];
  calls = [];
  started = [];
  steps = null;
  openbot = OPENBOT;
  capture = createNetworkCapture(
    {
      openbotUrl: () => openbot,
      call: (call) => {
        calls.push(call);
        steps?.call(call);
      },
      writeStarted: (id, tabId, startedAt) => {
        started.push(id);
        steps?.writeStarted(id, tabId, startedAt);
      },
      writeEnded: (id) => steps?.writeEnded(id),
      status: () => {},
      digests: () => new Set(),
      agent: (observation) =>
        observation.kind === "runtime"
          ? runtimes.push(observation)
          : observations.push(observation),
    },
    { fallback },
  );
});

afterEach(async () => {
  await capture.stop();
  steps?.clear();
  fake.uninstall();
});

/** The stream id the capture gives a request of the tab's own session. */
const streamOf = (requestId: string) => `${TAB}//${requestId}`;
const on = (streamId: string) =>
  observations.filter((observation) => observation.streamId === streamId);
const eventsOn = (streamId: string) =>
  on(streamId).flatMap((observation) =>
    observation.kind === "event" ? [observation.event] : [],
  );
const kinds = (streamId: string) => on(streamId).map(({ kind }) => kind);
const atEntry = (fixture: Fixture, test: (entry: FixtureEntry) => boolean) =>
  fixture.entries.find(test);

async function play(
  name: string,
): Promise<{ fixture: Fixture; replay: Replay }> {
  const fixture = loadFixture(name);
  const url = String(marks(fixture, "navigate")[0]?.data?.url);
  await capture.start(TAB, url);
  const played = replay(fake, TAB, fixture);
  return { fixture, replay: played };
}

/** The POSTs the page sent, with their bodies as Chrome gave them (inline, or read with getRequestPostData). */
function posts(fixture: Fixture) {
  const out: { id: string; url: string; body: unknown; wallTime: number }[] =
    [];
  for (const [id, sent] of requests(fixture)) {
    const request = sent.request as {
      url: string;
      method: string;
      postData?: string;
    };
    if (request.method !== "POST") continue;
    const read = fixture.entries.find(
      (entry) =>
        entry.kind === "command" &&
        entry.method === "Network.getRequestPostData" &&
        entry.params.requestId === id,
    );
    const text =
      request.postData ??
      (read?.kind === "command"
        ? (read.result?.postData as string | undefined)
        : undefined);
    let body: unknown = text;
    try {
      body = text === undefined ? undefined : JSON.parse(text);
    } catch {
      // Not JSON: its text.
    }
    out.push({ id, url: request.url, body, wallTime: sent.wallTime as number });
  }
  return out;
}

const envelope = (body: unknown) =>
  body as {
    method?: string;
    params?: { agentId?: string };
    body?: { threadId: string };
  };

test("a single-route run over SSE reaches the agent events live: its request out of the envelope, then every event CopilotKit's client read, in order, then its end", async () => {
  const { fixture, replay: played } = await play("single-route-sse");
  const runs = posts(fixture).filter(
    ({ body }) => envelope(body).method === "agent/run",
  );
  // The person's Send, then the run that answers Approve.
  expect(runs).toHaveLength(2);
  const [first] = runs;
  if (!first) throw new Error("no run");
  // Played up to the moment before the first run's answer finished: every event is already there, as it arrived.
  const finished = atEntry(
    fixture,
    (entry) =>
      entry.kind === "event" &&
      entry.method === "Network.loadingFinished" &&
      entry.params.requestId === first.id,
  );
  await played.run(
    (entry) => fixture.entries[fixture.entries.indexOf(entry) + 1] === finished,
  );
  const live = eventsOn(streamOf(first.id));
  expect(live.length).toBeGreaterThan(10);
  expect(kinds(streamOf(first.id))).not.toContain("end");
  await played.run();

  for (const run of runs) {
    const id = streamOf(run.id);
    const input = envelope(run.body).body;
    const expected = await clientEvents(
      "text/event-stream",
      responseBytes(fixture, run.id),
    );
    expect(on(id)[0]).toEqual({
      kind: "request",
      tabId: TAB,
      streamId: id,
      at: Math.round(run.wallTime * 1000),
      url: run.url,
      agentId: "default",
      method: "agent/run",
      input,
    });
    expect(eventsOn(id)).toEqual(expected);
    expect(on(id).at(-1)).toMatchObject({ kind: "end", outcome: "complete" });
    for (const observation of on(id))
      if (observation.kind === "event")
        expect(observation).toMatchObject({
          agentId: "default",
          threadId: input?.threadId,
        });
  }
  // The second run's first event was buffered before streaming began: it is there all the same.
  expect(eventsOn(streamOf(runs[1]?.id ?? ""))[0]).toMatchObject({
    type: "RUN_STARTED",
  });
  expect(live).toEqual(eventsOn(streamOf(first.id)));
  // Nothing else the page sent is an agent stream: the runtime's info, its Thread list, CopilotKit's own trajectory
  // batches and telemetry.
  expect(new Set(observations.map(({ streamId }) => streamId))).toEqual(
    new Set(runs.map(({ id }) => streamOf(id))),
  );
});

test("a REST run whose body CDP left out is read once, for the agent events and the steps alike; a suggestion's stream is the agent's without a run", async () => {
  const { fixture, replay: played } = await play("rest-sse");
  await played.run();
  const all = posts(fixture);
  const run = all.find(({ url }) => url.endsWith("/agent/default/run"));
  if (!run) throw new Error("no run");
  const sent = requests(fixture).get(run.id)?.request as { postData?: string };
  expect(sent.postData).toBeUndefined();
  expect(JSON.stringify(run.body).length).toBeGreaterThan(65_536);
  expect(
    fake.debugger.commands.filter(
      (command) =>
        command.method === "Network.getRequestPostData" &&
        (command.params as { requestId: string }).requestId === run.id,
    ),
  ).toHaveLength(1);
  expect(on(streamOf(run.id))[0]).toMatchObject({
    kind: "request",
    agentId: "default",
    method: "agent/run",
    input: run.body,
  });
  expect(eventsOn(streamOf(run.id))).toEqual(
    await clientEvents("text/event-stream", responseBytes(fixture, run.id)),
  );
  expect(kinds(streamOf(run.id)).at(-1)).toBe("end");

  const suggestions = all.filter(({ url }) =>
    url.endsWith("/agent/default/suggest"),
  );
  expect(suggestions.length).toBeGreaterThan(0);
  for (const suggestion of suggestions) {
    const id = streamOf(suggestion.id);
    expect(kinds(id)[0]).toBe("event");
    expect(kinds(id)).not.toContain("request");
    expect(eventsOn(id)).toEqual(
      await clientEvents(
        "text/event-stream",
        responseBytes(fixture, suggestion.id),
      ),
    );
    expect(on(id)[0]).toMatchObject({
      agentId: "default",
      threadId: (suggestion.body as { threadId: string }).threadId,
    });
  }
});

test("an AG-UI server that is not CopilotKit: a protobuf run and an SSE run are runs once their first event is AG-UI, a plain socket's events are the agent's, and an event stream that is not AG-UI is nothing", async () => {
  const { fixture, replay: played } = await play("generic-proto-ws-ticker");
  await played.run();
  const runs = posts(fixture);
  expect(runs).toHaveLength(2);
  const contentTypes = [AGUI_PROTO_TYPE, "text/event-stream"];
  for (const [index, run] of runs.entries()) {
    const id = streamOf(run.id);
    expect(on(id)[0]).toMatchObject({
      kind: "request",
      agentId: null,
      method: "agent/run",
      input: run.body,
    });
    expect(eventsOn(id)).toEqual(
      await clientEvents(
        contentTypes[index] ?? "",
        responseBytes(fixture, run.id),
      ),
    );
    expect(eventsOn(id).length).toBeGreaterThan(10);
    expect(on(id).at(-1)).toMatchObject({ kind: "end", outcome: "complete" });
    // A run is no step's save, nor a write a step waits for.
    expect(calls.map(({ url }) => url)).not.toContain(run.url);
    expect(started).not.toContain(`${TAB}//${run.id}`);
  }

  const [socket] = events(fixture, "Network.webSocketCreated");
  const socketId = socket?.params.requestId ?? "";
  const received = events(fixture, "Network.webSocketFrameReceived")
    .filter(({ params }) => params.requestId === socketId)
    .map(({ params }) =>
      JSON.parse((params.response as { payloadData: string }).payloadData),
    );
  const sent = events(fixture, "Network.webSocketFrameSent").filter(
    ({ params }) => params.requestId === socketId,
  );
  // The page sent its run input over the socket; only what the socket received is the agent's.
  expect(sent).toHaveLength(1);
  const plain = observations.filter(({ streamId }) =>
    streamId.startsWith(`${TAB}//${socketId}/ws/`),
  );
  expect(
    plain.flatMap((observation) =>
      observation.kind === "event" ? [observation.event] : [],
    ),
  ).toEqual(received);
  expect(plain.at(-1)).toMatchObject({ kind: "end", outcome: "complete" });

  const ticker = [...requests(fixture)].find(
    ([, sent]) => sent.type === "EventSource",
  );
  expect(ticker).toBeDefined();
  expect(on(streamOf(ticker?.[0] ?? ""))).toEqual([]);
  // Two runs and the socket: nothing else.
  expect(new Set(observations.map(({ streamId }) => streamId)).size).toBe(3);
});

test("an answer Chrome would not stream is read whole when it finishes, and a run the page stopped ends failed with what arrived", async () => {
  const { fixture, replay: played } = await play("late-and-aborted");
  const [late, aborted] = posts(fixture);
  if (!late || !aborted) throw new Error("two runs");
  const refused = fixture.entries.find(
    (entry) =>
      entry.kind === "command" &&
      entry.method === "Network.streamResourceContent" &&
      entry.params.requestId === late.id,
  );
  expect(refused?.kind === "command" ? refused.error : undefined).toBe(
    "Request with the provided ID has already finished loading",
  );
  await played.run();
  expect(eventsOn(streamOf(late.id))).toEqual(
    await clientEvents("text/event-stream", responseBytes(fixture, late.id)),
  );
  expect(eventsOn(streamOf(late.id)).length).toBeGreaterThan(10);
  expect(on(streamOf(late.id)).at(-1)).toMatchObject({
    kind: "end",
    outcome: "complete",
  });

  const stopped = events(fixture, "Network.loadingFailed").find(
    ({ params }) => params.requestId === aborted.id,
  );
  expect(stopped?.params.canceled).toBe(true);
  const arrived = eventsOn(streamOf(aborted.id));
  expect(arrived.length).toBeGreaterThan(0);
  expect(arrived).toEqual(
    await clientEvents("text/event-stream", responseBytes(fixture, aborted.id)),
  );
  expect(on(streamOf(aborted.id)).at(-1)).toMatchObject({
    kind: "end",
    outcome: "failed",
  });
});

test("CopilotKit through Intelligence: each run answers with its channel, and the Phoenix channel's ag_ui_event payloads are that run's events, its Thread and agent named, never a frame the page sent", async () => {
  const { fixture, replay: played } = await play("intelligence-websocket");
  await played.run();
  const runs = posts(fixture).filter(
    ({ body }) => envelope(body).method === "agent/run",
  );
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    // The run's own answer is join credentials, not a stream: a request and its end.
    expect(kinds(streamOf(run.id))).toEqual(["request", "end"]);
    expect(on(streamOf(run.id))[0]).toMatchObject({
      agentId: "default",
      method: "agent/run",
      input: envelope(run.body).body,
    });
  }

  const sockets = events(fixture, "Network.webSocketCreated");
  const threadSockets = sockets.filter(({ params }) =>
    events(fixture, "Network.webSocketFrameSent").some(
      ({ params: sent }) =>
        sent.requestId === params.requestId &&
        String((sent.response as { payloadData: string }).payloadData).includes(
          '"thread:',
        ),
    ),
  );
  expect(threadSockets).toHaveLength(2);
  let delivered = 0;
  for (const [index, socket] of threadSockets.entries()) {
    const socketId = String(socket.params.requestId);
    const frames = events(fixture, "Network.webSocketFrameReceived")
      .filter(({ params }) => params.requestId === socketId)
      .map(({ params }) =>
        phoenixFrame((params.response as { payloadData: string }).payloadData),
      );
    const payloads = frames
      .filter(({ event }) => event === "ag_ui_event")
      .map(({ payload }) => payload);
    const topic = frames[0]?.topic ?? "";
    const streams = new Set(
      observations
        .filter(({ streamId }) =>
          streamId.startsWith(`${TAB}//${socketId}/ws/`),
        )
        .map(({ streamId }) => streamId),
    );
    expect(streams.size).toBe(1);
    const [streamId] = [...streams];
    expect(streamId?.endsWith(`/${topic}`)).toBe(true);
    const threadId = envelope(runs[index]?.body).body?.threadId;
    expect(topic).toBe(`thread:${threadId}`);
    const stream = on(streamId ?? "");
    expect(eventsOn(streamId ?? "")).toEqual(payloads);
    expect(payloads.length).toBeGreaterThan(10);
    for (const observation of stream.slice(0, -1))
      expect(observation).toMatchObject({
        kind: "event",
        agentId: "default",
        threadId,
      });
    // The page leaves the channel once its run finished: the stream ends there.
    expect(stream.at(-1)).toMatchObject({ kind: "end", outcome: "complete" });
    delivered += payloads.length;
  }
  // The Thread-list socket (user_meta) and the dev server's socket carry no agent events; the page's joins, leaves and
  // heartbeats never are.
  expect(observations.filter(({ kind }) => kind === "event").length).toBe(
    delivered,
  );
});

test("a recording made in OpenBot itself sees its chat's runs, as on any other site, and none of OpenBot's other calls", async () => {
  // Run 3b of the end-to-end check, recorded again over CDP: OpenBot's chat posts connect, then run, to its own
  // CopilotKit runtime, and joins the Thread's channel on Intelligence's socket with the credentials connect answered.
  const fixture = loadFixture("openbot-chat");
  const navigate = String(marks(fixture, "navigate")[0]?.data?.url);
  openbot = new URL(navigate).origin;
  await capture.start(TAB, navigate);
  await replay(fake, TAB, fixture).run();

  const all = posts(fixture);
  const connect = all.find(({ url }) =>
    url.endsWith("/api/copilotkit/agent/general-assistant/connect"),
  );
  const run = all.find(({ url }) =>
    url.endsWith("/api/copilotkit/agent/general-assistant/run"),
  );
  if (!connect || !run) throw new Error("no connect or run");
  const thread = (connect.body as { threadId: string }).threadId;
  expect(on(streamOf(connect.id))).toEqual([
    expect.objectContaining({
      kind: "request",
      agentId: "general-assistant",
      method: "agent/connect",
      input: connect.body,
    }),
    expect.objectContaining({ kind: "end", outcome: "complete" }),
  ]);
  // The run this Intelligence refused: its request, and its end, failed.
  expect(on(streamOf(run.id))).toEqual([
    expect.objectContaining({
      kind: "request",
      agentId: "general-assistant",
      method: "agent/run",
      input: run.body,
    }),
    expect.objectContaining({ kind: "end", outcome: "failed" }),
  ]);
  expect((run.body as { threadId: string }).threadId).toBe(thread);
  // OpenBot's other calls (its router, the channel, its busy flag and activity, its polling) and its own channel socket
  // are nothing to the agent events, and none of OpenBot's calls is ever a step's.
  expect(new Set(observations.map(({ streamId }) => streamId))).toEqual(
    new Set([streamOf(connect.id), streamOf(run.id)]),
  );
  expect(calls).toEqual([]);
  expect(started).toEqual([]);
});

test("a recording made in OpenBot itself knows its page runs CopilotKit: its runtime answered the info call, and nothing else OpenBot answered says so", async () => {
  // End-to-end run 3's clicks named no Thread at all: OpenBot's page asked its runtime's `info` (GET
  // /api/copilotkit/info, answered with CopilotKit's RuntimeInfo) when it loaded and again after the run, but the capture
  // ignored it with the rest of OpenBot's own calls.
  const fixture = loadFixture("openbot-chat");
  const navigate = String(marks(fixture, "navigate")[0]?.data?.url);
  openbot = new URL(navigate).origin;
  await capture.start(TAB, navigate);
  await replay(fake, TAB, fixture).run();

  const infos = exchanges(fixture).filter(
    ({ url, method, body, status, answer }) =>
      matchRuntimeInfoRequest(url, method, body) &&
      isRuntimeInfoAnswer(status, answer),
  );
  expect(
    infos.map(({ method, url }) => `${method} ${new URL(url).pathname}`),
  ).toEqual(["GET /api/copilotkit/info", "GET /api/copilotkit/info"]);
  expect(
    runtimes.map(({ kind, tabId, url }) => ({ kind, tabId, url })),
  ).toEqual(infos.map(({ url }) => ({ kind: "runtime", tabId: TAB, url })));
  // Each at its answer's end, after its request.
  for (const [index, runtime] of runtimes.entries()) {
    const sent = requests(fixture).get(infos[index]?.id ?? "") as unknown as {
      wallTime: number;
    };
    expect(runtime.at).toBeGreaterThanOrEqual(Math.round(sent.wallTime * 1000));
  }
  expect(calls).toEqual([]);
  expect(started).toEqual([]);
});

test("an Intelligence gateway served on OpenBot's own origin: the channel's socket is followed, its events the run's", async () => {
  // The traffic of the Intelligence test above, with the gateway's origin as the connected OpenBot's, as a deployment
  // that serves Intelligence's socket on OpenBot's host has it: the sockets opened with join credentials are followed,
  // and each channel's ag_ui_event payloads are still that run's events.
  const fixture = loadFixture("intelligence-websocket");
  const sockets = events(fixture, "Network.webSocketCreated").filter(
    ({ params }) =>
      String(params.url).includes("/client/websocket?join_token="),
  );
  const [socket] = sockets;
  if (!socket) throw new Error("no Intelligence socket");
  openbot = new URL(String(socket.params.url).replace(/^ws/, "http")).origin;
  await capture.start(TAB, String(marks(fixture, "navigate")[0]?.data?.url));
  await replay(fake, TAB, fixture).run();
  const ids = new Set(sockets.map(({ params }) => params.requestId));
  const delivered = events(fixture, "Network.webSocketFrameReceived")
    .filter(({ params }) => ids.has(params.requestId))
    .map(({ params }) =>
      phoenixFrame((params.response as { payloadData: string }).payloadData),
    )
    .filter(({ event }) => event === "ag_ui_event");
  expect(delivered.length).toBeGreaterThan(20);
  const seen = observations.filter(({ kind }) => kind === "event");
  expect(
    seen.map(
      (observation) => observation.kind === "event" && observation.event,
    ),
  ).toEqual(delivered.map(({ payload }) => payload));
  for (const observation of seen)
    expect(observation).toMatchObject({ agentId: "default" });
});

// ---- Steps ------------------------------------------------------------------------------------

/** The steps' timing, shortened so a test runs in a moment; every rule is the same. */
const TIMING = {
  windowMs: 400,
  chainGapMs: 100,
  maxDepth: 2,
  horizonMs: 600,
  leadMs: 100,
  settleMs: 150,
  redirectMs: 50,
  inflightCapMs: 3_000,
};

const stepEvent = (
  name: string,
  timestamp: number,
  value: Record<string, unknown>,
): CapturedEvent => ({
  type: "CUSTOM",
  name,
  timestamp,
  value: value as CapturedEvent["value"],
});

test("the chat's Send is no longer held for the run it starts, nor does it carry the run as its save, and the run's agent events leave after it", async () => {
  const fixture = loadFixture("single-route-sse");
  await capture.start(TAB, String(marks(fixture, "navigate")[0]?.data?.url));
  const played = replay(fake, TAB, fixture, {
    onMark(mark) {
      if (mark.name === "typed")
        steps?.step(
          TAB,
          stepEvent("input", mark.wall, {
            step: "input",
            target: {
              tag: "textarea",
              role: "textbox",
              value: String(mark.data?.text),
            },
          }),
        );
      if (mark.name === "click" && mark.data?.name === "send")
        steps?.step(
          TAB,
          stepEvent("click", mark.wall, {
            step: "click",
            target: { tag: "button", role: "button", name: "Send" },
          }),
        );
    },
  });
  const sent: CapturedEvent[] = [];
  steps = createStepAssembler({
    emit: (event) => sent.push(event),
    now: () => played.now(),
    tuning: TIMING,
  });
  // The agent events' side, as slice B's emit hands it on: each observation placed among the steps by its time.
  const agent = (observation: AgentObservation) =>
    steps?.place(observation.tabId, {
      type: "CUSTOM",
      name: `agent.${observation.kind}`,
      timestamp: observation.at,
      value: { streamId: observation.streamId },
    });
  const seen = observations.length;
  const send = marks(fixture, "click").find(
    ({ data }) => data?.name === "send",
  );
  if (!send) throw new Error("no Send");
  // Quickly up to Send, then as it happened for 2.5 s: the run's answer streams on for more than 4 s after it.
  await played.run((entry) => entry === send);
  for (const observation of observations.splice(seen)) agent(observation);
  const watch = setInterval(() => {
    for (const observation of observations.splice(0)) agent(observation);
  }, 5);
  await played.run((entry) => entry.t >= send.t + 2_500, 1);
  clearInterval(watch);
  for (const observation of observations.splice(0)) agent(observation);

  const run = posts(fixture).find(
    ({ body }) => envelope(body).method === "agent/run",
  );
  if (!run) throw new Error("no run");
  // Before, the run's POST was a write in flight: Send waited for it (up to inflightCapMs) and then carried the run's
  // input, the message just typed, as its save.
  expect(started).not.toContain(`${TAB}//${run.id}`);
  const names = sent.map(({ name }) => name);
  const click = sent.find(({ name }) => name === "click");
  if (!click) throw new Error("Send never left the steps");
  expect((click.value as { request?: unknown }).request).toBeUndefined();
  // The run's request and its first events came while Send was held: they leave after it, in time order.
  const firstAgent = names.findIndex((name) => name.startsWith("agent."));
  expect(firstAgent).toBeGreaterThan(names.indexOf("click"));
  expect(names.filter((name) => name === "agent.event").length).toBeGreaterThan(
    0,
  );
  const times = sent.map(({ timestamp }) => timestamp);
  expect(times).toEqual([...times].sort((a, b) => a - b));
});

/** Every request each recorded page made, with its body and its answer as Chrome gave them. */
function exchanges(fixture: Fixture) {
  const statuses = new Map<string, number>();
  for (const entry of events(fixture, "Network.responseReceived"))
    statuses.set(
      String(entry.params.requestId),
      (entry.params.response as { status: number }).status,
    );
  return [...requests(fixture)].map(([id, sent]) => {
    const request = sent.request as {
      url: string;
      method: string;
      postData?: string;
    };
    const read = fixture.entries.find(
      (entry) =>
        entry.kind === "command" &&
        entry.method === "Network.getRequestPostData" &&
        entry.params.requestId === id,
    );
    return {
      id,
      url: request.url,
      method: request.method,
      body:
        request.postData ??
        (read?.kind === "command"
          ? (read.result?.postData as string | undefined)
          : undefined),
      status: statuses.get(id) ?? null,
      answer: new TextDecoder().decode(responseBytes(fixture, id)),
    };
  });
}

const RECORDED = [
  "single-route-sse",
  "rest-sse",
  "intelligence-websocket",
  "generic-proto-ws-ticker",
  "late-and-aborted",
];

test("CopilotKit's runtime info call, answered by CopilotKit's runtime, is known on the single route, over REST and through Intelligence; no other request the recorded pages made is", () => {
  const found = RECORDED.flatMap((name) =>
    exchanges(loadFixture(name))
      .filter(
        (exchange) =>
          matchRuntimeInfoRequest(
            exchange.url,
            exchange.method,
            exchange.body,
          ) && isRuntimeInfoAnswer(exchange.status, exchange.answer),
      )
      .map(
        ({ method, url, body }) =>
          `${name}: ${method} ${new URL(url).pathname} ${body ?? ""}`,
      ),
  );
  expect(found).toEqual([
    'single-route-sse: POST /api/copilotkit-learning {"method":"info"}',
    "rest-sse: GET /api/copilotkit/info ",
    'intelligence-websocket: POST /api/copilotkit-learning {"method":"info"}',
  ]);
});

test("the debugger capture says a page runs CopilotKit once its runtime answered the info call, at the answer's end", async () => {
  const { fixture, replay: played } = await play("single-route-sse");
  await played.run();
  const info = exchanges(fixture).find(
    ({ body }) => body === '{"method":"info"}',
  );
  if (!info) throw new Error("no info call");
  const finished = events(fixture, "Network.loadingFinished").find(
    (entry) => entry.params.requestId === info.id,
  );
  const sent = requests(fixture).get(info.id) as unknown as {
    timestamp: number;
    wallTime: number;
  };
  expect(runtimes).toEqual([
    {
      kind: "runtime",
      tabId: TAB,
      url: info.url,
      // The answer's end on Chrome's monotonic clock, read against the wall clock its request carried.
      at: Math.round(
        Math.round(sent.wallTime * 1000) +
          ((finished?.params.timestamp as number) - sent.timestamp) * 1000,
      ),
    },
  ]);
});
