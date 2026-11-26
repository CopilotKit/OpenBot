/**
 * The conversation's socket (api/asyncapi.yaml, threadStream): it joins the topic the join token names, hands on each
 * event once, opens again with a new token after a drop from the last event drawn, and gives up quietly on a server
 * that has no join tokens.
 */
import { beforeEach, expect, test } from "bun:test";
import { socketAddress, watchConversation } from "../src/live-thread";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Sent = unknown[];
class FakeSocket {
  static opened: FakeSocket[] = [];
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    _protocols: null,
    readonly options: { headers: Record<string, string> },
  ) {
    FakeSocket.opened.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  frame(event: string, payload: unknown, topic = "thread:t1") {
    this.onmessage?.({
      data: JSON.stringify(["1", null, topic, event, payload]),
    });
  }
}

const token = (runId: string | null = null) => ({
  joinToken: "jt",
  expiresAt: "2026-11-26T10:00:30.000Z",
  threadId: "t1",
  runId,
  realtime: {
    clientUrl: "/api/v2/organizations/o1/realtime",
    topic: "thread:t1",
  },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeSocket.opened = [];
});

function watch(joinToken: () => Promise<ReturnType<typeof token>>) {
  const events: [string, boolean][] = [];
  const caught: (string | null)[] = [];
  const watcher = watchConversation(
    "c1",
    {
      onEvent: (event, replayed) => events.push([event.type, replayed]),
      onCaughtUp: (runId) => caught.push(runId),
    },
    {
      joinToken: joinToken as never,
      open: (url, headers) => new FakeSocket(url, null, { headers }),
      accessToken: async () => "access",
      clientHeaders: () => ({ "OpenBot-Client": "mobile/test" }),
      server: "https://api.example.test",
      inFront: () => true,
      onInFront: () => () => {},
    },
  );
  return { events, caught, watcher };
}

test("the socket is the token's address on this server, with the token, and the access token on the upgrade", () => {
  expect(socketAddress(token(), "https://api.example.test")).toEqual({
    url: "wss://api.example.test/api/v2/organizations/o1/realtime/websocket?join_token=jt&vsn=2.0.0",
    ours: true,
  });
  expect(
    socketAddress(
      {
        ...token(),
        realtime: {
          clientUrl: "wss://gateway.test/client/",
          topic: "thread:t1",
        },
      },
      "https://api.example.test",
    ),
  ).toEqual({
    url: "wss://gateway.test/client/websocket?join_token=jt&vsn=2.0.0",
    ours: false,
  });
});

test("it joins the token's topic, and hands on replayed and live events once each", async () => {
  const { events, caught, watcher } = watch(async () => token("r1"));
  await tick();
  await tick();
  const [socket] = FakeSocket.opened;
  expect(socket.options.headers.Authorization).toBe("Bearer access");
  socket.onopen?.();
  expect(socket.sent[0]).toEqual(["1", "1", "thread:t1", "phx_join", {}]);
  const event = (type: string, id: string) => ({
    type,
    metadata: { cpki_event_id: id },
  });
  socket.frame("ag_ui_event", event("RUN_STARTED", "e1"));
  socket.frame("ag_ui_event", event("RUN_STARTED", "e1"));
  socket.frame("replay_complete", { thread_id: "t1" });
  socket.frame("ag_ui_event", event("TEXT_MESSAGE_CONTENT", "e2"));
  // Another topic's frame is not this conversation's.
  socket.frame("ag_ui_event", event("RUN_FINISHED", "e3"), "thread:other");
  expect(events).toEqual([
    ["RUN_STARTED", true],
    ["TEXT_MESSAGE_CONTENT", false],
  ]);
  expect(caught).toEqual(["r1"]);
  watcher.stop();
  expect(socket.closed).toBe(true);
});

test("after a drop it opens again with a new token, from the last event drawn", async () => {
  let tokens = 0;
  const { events, watcher } = watch(async () => {
    tokens += 1;
    return token();
  });
  await tick();
  await tick();
  const first = FakeSocket.opened[0];
  first.onopen?.();
  first.frame("ag_ui_event", {
    type: "RUN_STARTED",
    metadata: { cpki_event_id: "e1" },
  });
  first.frame("expired", { reason: "time" });
  expect(first.closed).toBe(true);
  // A drop waits a second before opening again.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await tick();
  const second = FakeSocket.opened[1];
  expect(tokens).toBe(2);
  second.onopen?.();
  expect(second.sent[0]).toEqual([
    "2",
    "2",
    "thread:t1",
    "phx_join",
    { last_seen_event_id: "e1" },
  ]);
  second.frame("ag_ui_event", {
    type: "RUN_STARTED",
    metadata: { cpki_event_id: "e1" },
  });
  expect(events).toHaveLength(1);
  watcher.stop();
});

test("a server with no join tokens is given up on, and nothing is opened", async () => {
  let asked = 0;
  const { watcher } = watch(async () => {
    asked += 1;
    throw new FakeApiError("Not found", 404);
  });
  await tick();
  watcher.reconnect();
  await tick();
  expect(FakeSocket.opened).toHaveLength(0);
  expect(asked).toBe(1);
  watcher.stop();
});

test("a conversation no Bot has run in yet opens once a message gives it something to join", async () => {
  let ready = false;
  const { watcher } = watch(async () => {
    if (!ready) throw new FakeApiError("Nothing to join", 409);
    return token();
  });
  await tick();
  expect(FakeSocket.opened).toHaveLength(0);
  ready = true;
  watcher.reconnect();
  await tick();
  await tick();
  expect(FakeSocket.opened).toHaveLength(1);
  watcher.stop();
});
