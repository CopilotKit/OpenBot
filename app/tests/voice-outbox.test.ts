import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SaveVoiceSessionInput } from "../../shared/voice-session";
import { authKeys } from "../src/lib/auth/queries";
import {
  forgetVoiceCall,
  recoverVoiceCalls,
  rememberVoiceCall,
} from "../src/lib/voice/outbox";
import { queryClient } from "../src/query-client";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  localStorage.clear();
  queryClient.clear();
});
const call: SaveVoiceSessionInput = {
  id: "call",
  channelId: "channel",
  anchorMessageId: null,
  startedAt: "2026-09-22T12:00:00Z",
  endedAt: "2026-09-22T12:01:00Z",
  transcript: [
    { id: "turn", role: "user", text: "Remember the recording plan." },
  ],
};
function signIn(id: string) {
  queryClient.setQueryData(authKeys.currentUser(), { id });
}

test("an unconfirmed call survives clearing memory and remains isolated by user and channel", () => {
  signIn("alice");
  expect(rememberVoiceCall(call)).toBe(true);
  queryClient.clear();
  signIn("bob");
  expect(recoverVoiceCalls("channel")).toEqual([]);
  signIn("alice");
  expect(recoverVoiceCalls("different")).toEqual([]);
  expect(recoverVoiceCalls("channel")).toEqual([call]);
  forgetVoiceCall(call);
  expect(recoverVoiceCalls("channel")).toEqual([]);
});

test("anonymous calls are not written to another user's outbox", () => {
  expect(rememberVoiceCall(call)).toBe(false);
  expect(localStorage.length).toBe(0);
});

test("the captured call owner allows recovery when signing out clears authentication before hangup", () => {
  signIn("alice");
  queryClient.clear();
  expect(rememberVoiceCall(call, "alice")).toBe(true);
  signIn("alice");
  expect(recoverVoiceCalls("channel")).toEqual([call]);
});

test("malformed stored entries do not hide a valid recoverable call", () => {
  signIn("alice");
  rememberVoiceCall(call);
  localStorage.setItem("openbot:voice-outbox:alice:channel:broken", "{");
  localStorage.setItem(
    "openbot:voice-outbox:alice:channel:invalid",
    JSON.stringify({ ...call, transcript: [{}] }),
  );
  expect(recoverVoiceCalls("channel")).toEqual([call]);
});
