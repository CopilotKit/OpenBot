import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { askChannelAgent, voiceContext } from "../src/lib/voice/agent-bridge";
import { decodePcm, encodePcm } from "../src/lib/voice/pcm";
import { VoiceSession } from "../src/lib/voice/session";
import type {
  ConnectVoice,
  VoiceConnection,
  VoiceEvent,
} from "../src/lib/voice/types";

function setup(
  askAgent: (
    request: string,
    signal: AbortSignal,
  ) => Promise<string> = async () => "Agent result",
) {
  let receive: (event: VoiceEvent) => void = () => {};
  let closed = 0;
  let muted = false;
  const sent: VoiceEvent[] = [];
  const connection: VoiceConnection = {
    stream: new EventTarget() as MediaStream,
    send: (event) => {
      sent.push(event);
    },
    mute: (value) => {
      muted = value;
    },
    close: () => {
      closed++;
    },
  };
  const connect: ConnectVoice = async (options) => {
    receive = options.onEvent;
    return connection;
  };
  const session = new VoiceSession({
    channelId: "channel-1",
    connect,
    askAgent,
    context: () => "user: Old request",
  });
  return {
    session,
    sent,
    emit: (event: VoiceEvent) => receive(event),
    closed: () => closed,
    muted: () => muted,
  };
}
const tool = (id = "call-1", request = "Find a meeting time") => ({
  type: "response.function_call_arguments.done",
  name: "ask_agent",
  call_id: id,
  arguments: JSON.stringify({ request }),
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("joining a call loads thread context without asking the agent to speak", async () => {
  const fixture = setup();
  try {
    await fixture.session.start();
    expect(fixture.session.getSnapshot().phase).toBe("connected");
    expect(JSON.stringify(fixture.sent)).toContain("Old request");
    expect(fixture.sent.some((event) => event.type === "response.create")).toBe(
      false,
    );
    expect(fixture.session.getSnapshot().speaking).toBe(false);
  } finally {
    fixture.session.end();
  }
});

test("muting the caller leaves agent playback and replies active", async () => {
  const fixture = setup();
  try {
    await fixture.session.start();
    fixture.emit({ type: "output_audio_buffer.started" });
    fixture.session.mute();
    fixture.emit({
      type: "response.output_audio_transcript.delta",
      delta: "Still speaking",
    });
    expect(fixture.muted()).toBe(true);
    expect(fixture.session.getSnapshot()).toMatchObject({
      muted: true,
      speaking: true,
      reply: "Still speaking",
    });
    expect(fixture.closed()).toBe(0);
    fixture.session.mute();
    expect(fixture.muted()).toBe(false);
  } finally {
    fixture.session.end();
  }
});

test("voice delegates once even when the provider repeats its function call in response.done", async () => {
  const pending = Promise.withResolvers<string>();
  const requests: string[] = [];
  const fixture = setup(async (text) => {
    requests.push(text);
    return pending.promise;
  });
  try {
    await fixture.session.start();
    fixture.emit(tool());
    fixture.emit({
      type: "response.done",
      response: { output: [{ ...tool(), type: "function_call" }] },
    });
    expect(requests).toEqual(["Find a meeting time"]);
    expect(fixture.session.getSnapshot().working).toBe(true);
    pending.resolve("Tuesday at 10");
    await tick();
    await tick();
    const results = fixture.sent.filter(
      (event) =>
        event.type === "conversation.item.create" &&
        JSON.stringify(event.item).includes("function_call_output"),
    );
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).toContain("Tuesday at 10");
    expect(fixture.session.getSnapshot().working).toBe(false);
  } finally {
    fixture.session.end();
  }
});

test("hangup ignores late tool results and closes the transport", async () => {
  const pending = Promise.withResolvers<string>();
  const fixture = setup(async () => pending.promise);
  await fixture.session.start();
  fixture.emit(tool());
  fixture.session.end();
  const count = fixture.sent.length;
  pending.resolve("Late result");
  await tick();
  await tick();
  expect(fixture.sent).toHaveLength(count);
  expect(fixture.closed()).toBe(1);
  expect(fixture.session.getSnapshot().phase).toBe("idle");
});

test("hangup during connection closes a late transport and never sends a greeting", async () => {
  const pending = Promise.withResolvers<VoiceConnection>();
  let closed = false;
  const session = new VoiceSession({
    channelId: "channel-1",
    connect: async () => pending.promise,
    context: () => "",
    askAgent: async () => "",
  });
  const start = session.start();
  await tick();
  session.end();
  pending.resolve({
    stream: new EventTarget() as MediaStream,
    close: () => {
      closed = true;
    },
    mute() {},
    send() {
      throw new Error("Must not send after hangup");
    },
  });
  await start;
  expect(closed).toBe(true);
  expect(session.getSnapshot().phase).toBe("idle");
});

test("an overlapping voice tool request is refused without executing a second task", async () => {
  const pending = Promise.withResolvers<string>();
  let count = 0;
  const fixture = setup(async () => {
    count++;
    return pending.promise;
  });
  try {
    await fixture.session.start();
    fixture.emit(tool());
    fixture.emit(tool("call-2", "Delete it instead"));
    await tick();
    expect(count).toBe(1);
    expect(JSON.stringify(fixture.sent)).toContain("still working");
    expect(fixture.session.getSnapshot().working).toBe(true);
    fixture.emit({ type: "response.done", response: { output: [] } });
    expect(
      fixture.sent.filter((event) => event.type === "response.create"),
    ).toHaveLength(0);
  } finally {
    fixture.session.end();
    pending.resolve("Finished");
  }
});

test("a VAD response consumes tool results received during user speech without a duplicate reply", async () => {
  const pending = Promise.withResolvers<string>();
  const fixture = setup(async () => pending.promise);
  try {
    await fixture.session.start();
    fixture.emit({ type: "response.done", response: { output: [] } });
    fixture.emit(tool());
    fixture.emit({ type: "input_audio_buffer.speech_started" });
    pending.resolve("Current result");
    await tick();
    await tick();
    fixture.emit({ type: "input_audio_buffer.speech_stopped" });
    fixture.emit({ type: "response.created" });
    fixture.emit({ type: "response.done", response: { output: [] } });
    expect(
      fixture.sent.filter((event) => event.type === "response.create"),
    ).toHaveLength(0);
  } finally {
    fixture.session.end();
  }
});

test("provider and agent failures are surfaced; mute updates microphone ownership", async () => {
  const fixture = setup(async () => {
    throw new Error("The agent is unavailable");
  });
  await fixture.session.start();
  fixture.session.mute();
  expect(fixture.muted()).toBe(true);
  fixture.emit(tool());
  await tick();
  expect(JSON.stringify(fixture.sent)).toContain("agent is unavailable");
  fixture.emit({ type: "error", error: { code: "invalid_request" } });
  expect(fixture.session.getSnapshot().phase).toBe("error");
  expect(fixture.closed()).toBe(1);
  fixture.session.end();
});

test("bad tool arguments cannot run agent work", async () => {
  let count = 0;
  const fixture = setup(async () => {
    count++;
    return "";
  });
  try {
    await fixture.session.start();
    fixture.emit({ ...tool(), arguments: "{}" });
    fixture.emit({ ...tool("call-2"), name: "delete_everything" });
    await tick();
    expect(count).toBe(0);
    expect(JSON.stringify(fixture.sent)).toContain("error");
  } finally {
    fixture.session.end();
  }
});

test("voice bridge returns only the new agent answer and respects shared thread busy state", async () => {
  const messages: Message[] = [
    { id: "old", role: "assistant", content: "Old answer" },
  ];
  let busy = true;
  const requests: string[] = [];
  const channel = {
    busy: () => busy,
    send: async (request: string) => {
      requests.push(request);
      messages.push({ id: "new", role: "assistant", content: "New answer" });
      return "New answer";
    },
  };
  const signal = new AbortController().signal;
  await expect(askChannelAgent("Hello", signal, channel)).rejects.toThrow(
    "still working",
  );
  expect(requests).toEqual([]);
  busy = false;
  expect(await askChannelAgent("Hello", signal, channel)).toBe("New answer");
  expect(requests).toEqual(["Hello"]);
});

test("voice context excludes system instructions and tool payloads", () => {
  expect(
    voiceContext([
      { id: "system", role: "system", content: "Private instructions" },
      { id: "user", role: "user", content: "Hello" },
      {
        id: "tool",
        role: "tool",
        toolCallId: "call",
        content: "Raw tool payload",
      },
    ]),
  ).toBe("user: Hello");
});

test("Grok PCM transport preserves signed little-endian audio samples", () => {
  const bytes = new Uint8Array([0, 128, 0, 0, 255, 127]);
  expect([...decodePcm(encodePcm(bytes.buffer))]).toEqual([
    -1,
    0,
    32767 / 32768,
  ]);
  expect(() => decodePcm(btoa("x"))).toThrow("Invalid audio");
});
