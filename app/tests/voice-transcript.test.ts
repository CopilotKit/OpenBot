import { expect, test } from "bun:test";
import type { SaveVoiceSessionInput } from "../../shared/voice-session";
import {
  VoiceTranscript,
  VOICE_CONTEXT_ITEM_ID,
} from "../src/lib/voice/transcript";
import { VoiceSession } from "../src/lib/voice/session";
import type { VoiceEvent } from "../src/lib/voice/types";

test("late input transcription keeps the user's turn ahead of the live answer", () => {
  const transcript = new VoiceTranscript();
  transcript.receive({
    type: "input_audio_buffer.committed",
    item_id: "user-1",
  });
  transcript.receive({
    type: "response.output_audio_transcript.delta",
    item_id: "reply-1",
    delta: "Hello",
  });
  transcript.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user-1",
    transcript: "Hi",
  });
  transcript.receive({
    type: "response.output_audio_transcript.done",
    item_id: "reply-1",
    transcript: "Hello!",
  });
  transcript.receive({
    type: "conversation.item.done",
    item: {
      id: "reply-1",
      type: "message",
      role: "assistant",
      content: [{ transcript: "Hello!" }],
    },
  });
  expect(transcript.read()).toEqual([
    { id: "user-1", role: "user", text: "Hi" },
    { id: "reply-1", role: "assistant", text: "Hello!" },
  ]);
});

test("seeded thread context and tool outputs do not become spoken transcript entries", () => {
  const transcript = new VoiceTranscript();
  transcript.receive({
    type: "conversation.item.done",
    item: {
      id: VOICE_CONTEXT_ITEM_ID,
      type: "message",
      role: "user",
      content: [{ text: "Previous chat context" }],
    },
  });
  transcript.receive({
    type: "conversation.item.done",
    item: {
      id: "tool",
      type: "function_call_output",
      output: "Private tool data",
    },
  });
  expect(transcript.read()).toEqual([]);
});

test("transcript limits retain a valid saveable prefix", () => {
  const transcript = new VoiceTranscript();
  transcript.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user-1",
    transcript: "First turn",
  });
  transcript.receive({
    type: "response.output_audio_transcript.done",
    item_id: "reply-1",
    transcript: "x".repeat(60_001),
  });
  expect(transcript.full).toBe(true);
  expect(transcript.read()).toEqual([
    { id: "user-1", role: "user", text: "First turn" },
  ]);
});

test("interrupted replies never retain queued words as though they were heard", () => {
  const transcript = new VoiceTranscript();
  transcript.receive({
    type: "response.output_audio_transcript.done",
    item_id: "reply",
    transcript: "A very long answer that has not played yet.",
  });
  transcript.receive({ type: "output_audio_buffer.started" });
  transcript.receive({ type: "output_audio_buffer.cleared" });
  transcript.receive({
    type: "response.output_audio_transcript.done",
    item_id: "reply",
    transcript: "A very long answer that has not played yet.",
  });
  expect(transcript.read()[0]?.text).toContain("interrupted");
  expect(transcript.read()[0]?.text).not.toContain("long answer");
});

test("direct conversation never delegates; hangup saves once after releasing audio", async () => {
  let emit: (event: VoiceEvent) => void = () => {};
  let closed = false;
  let requests = 0;
  const saved: SaveVoiceSessionInput[] = [];
  const session = new VoiceSession({
    channelId: "channel-1",
    context: () => "",
    anchorMessageId: () => "previous-message",
    connect: async (options) => {
      emit = options.onEvent;
      return {
        stream: new EventTarget() as MediaStream,
        send() {},
        mute() {},
        close() {
          closed = true;
        },
      };
    },
    askAgent: async () => {
      requests++;
      return "Delegated result";
    },
    onEnd: (call) => {
      expect(closed).toBe(true);
      saved.push(call);
    },
  });
  await session.start();
  emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user",
    transcript: "Help me brainstorm",
  });
  emit({
    type: "response.output_audio_transcript.done",
    item_id: "assistant",
    transcript: "Let's start with your goal.",
  });
  session.end();
  session.end();
  emit({
    type: "response.output_audio_transcript.done",
    item_id: "late",
    transcript: "Late callback",
  });
  expect(requests).toBe(0);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.anchorMessageId).toBe("previous-message");
  expect(saved[0]?.transcript).toHaveLength(2);
});

test("joining and hanging up silently does not save an empty voice chat", async () => {
  let saved = false;
  const session = new VoiceSession({
    channelId: "channel-1",
    context: () => "",
    askAgent: async () => "",
    connect: async () => ({
      stream: new EventTarget() as MediaStream,
      send() {},
      mute() {},
      close() {},
    }),
    onEnd: () => {
      saved = true;
    },
  });
  await session.start();
  session.end();
  expect(saved).toBe(false);
});
