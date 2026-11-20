import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { type VoiceChatEntry, withVoiceChats } from "@/lib/voice/archive";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation shows without its voice chats when the voice service is slow, and the cards join
 * it when they arrive. A card for a call that happened before the conversation opened is history:
 * it lands among rows already on screen and must not play the entrance of something that just
 * happened. A call made while the conversation is open still arrives as one.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const history: Message[] = [
  { id: "u1", role: "user", content: "one" },
  { id: "a1", role: "assistant", content: "two" },
  { id: "u2", role: "user", content: "three" },
  { id: "a2", role: "assistant", content: "four" },
];

function call(id: string, startedAt: Date): VoiceChatEntry {
  return {
    id,
    channelId: "c",
    anchorMessageId: "a1",
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + 60_000).toISOString(),
    transcript: [],
    durationSeconds: 60,
    summary: null,
    summaryStatus: "ready",
  };
}

function transcript(calls: VoiceChatEntry[]) {
  return (
    <CopilotKitProvider>
      <ChatTranscript
        messages={withVoiceChats(history, calls)}
        restoring={false}
      />
    </CopilotKitProvider>
  );
}

function cardStartsHidden(container: HTMLElement): boolean {
  const row = container.querySelector('[data-message-id^="voice-chat:"]');
  const arriving = row?.querySelector('[data-slot="message-arriving"]');
  expect(arriving).not.toBeNull();
  return /opacity:\s*0(?![.\d])/.test(arriving?.getAttribute("style") ?? "");
}

test("a voice chat from before the conversation opened arrives at rest", () => {
  const view = render(transcript([]));

  view.rerender(transcript([call("v1", new Date(Date.now() - 3_600_000))]));

  expect(cardStartsHidden(view.container)).toBe(false);
});

test("a voice chat made while the conversation is open arrives live", () => {
  const view = render(transcript([]));

  view.rerender(transcript([call("v2", new Date(Date.now() + 1_000))]));

  expect(cardStartsHidden(view.container)).toBe(true);
});
