import { describe, expect, test } from "bun:test";
import {
  hearingUnderOwnThreadId,
  underOwnThreadId,
} from "@/lib/copilot/live-thread-updates";

/**
 * A run started somewhere else on the open thread is picked up live.
 *
 * The chat reconnects when a live update names its own thread id, and ignores every other. Live
 * updates carry the thread's live id, which outside the organization `default` is not the id the
 * chat has. These tests stand where the chat stands: a listener that takes an update only when it
 * names the chat's own id, on a store that announces runs the way the real one does.
 */

type Update = { threadId: string; runId: string; eventType: string };

/** A thread store's live side: it tells every listener about each run it is told of. */
function announcingStore() {
  const listeners = new Set<(update: Update) => void>();
  return {
    started: false,
    start() {
      this.started = true;
    },
    subscribeToRunActivity(listener: (update: Update) => void) {
      listeners.add(listener);
      return { unsubscribe: () => void listeners.delete(listener) };
    },
    announce(update: Update) {
      for (const listener of listeners) listener(update);
    },
  };
}

/** The chat's own rule: an update is about this chat only when it names the chat's thread id. */
function chatListening(threadId: string) {
  const pickedUp: string[] = [];
  return {
    pickedUp,
    hear(update: Update) {
      if (update.threadId !== threadId) return;
      pickedUp.push(update.runId);
    },
  };
}

const THREAD = "6f3d6b1f-6f10-8a53-9d51-5f0d6c0e2f1a";
const LIVE = "2b503bf7-514a-8c4e-b132-3ca9b729ffeb";
const started = (threadId: string, runId: string): Update => ({
  threadId,
  runId,
  eventType: "RUN_STARTED",
});

describe("outside the organization default, where a thread's live id is not its own", () => {
  test("a run started elsewhere on the open thread reaches the chat", () => {
    const store = announcingStore();
    const chat = chatListening(THREAD);
    hearingUnderOwnThreadId(store, {
      threadId: THREAD,
      liveThreadId: LIVE,
    }).subscribeToRunActivity((update) => chat.hear(update));

    store.announce(started(LIVE, "run-from-another-tab"));
    store.announce(started(LIVE, "run-of-a-routine"));

    expect(chat.pickedUp).toEqual(["run-from-another-tab", "run-of-a-routine"]);
  });

  test("without it the same run is missed, which is what a person saw as a chat that needed reloading", () => {
    const store = announcingStore();
    const chat = chatListening(THREAD);
    store.subscribeToRunActivity((update) => chat.hear(update));

    store.announce(started(LIVE, "run-from-another-tab"));

    expect(chat.pickedUp).toEqual([]);
  });

  test("a run on another thread is still not this chat's", () => {
    const store = announcingStore();
    const chat = chatListening(THREAD);
    hearingUnderOwnThreadId(store, {
      threadId: THREAD,
      liveThreadId: LIVE,
    }).subscribeToRunActivity((update) => chat.hear(update));

    store.announce(started("0c8f8a52-1b1c-8e0f-a3f4-0e4f5b6a7c8d", "theirs"));

    expect(chat.pickedUp).toEqual([]);
  });

  test("an update keeps everything but the thread it names, and stops when the chat stops listening", () => {
    const store = announcingStore();
    const heard: Update[] = [];
    const subscription = hearingUnderOwnThreadId(store, {
      threadId: THREAD,
      liveThreadId: LIVE,
    }).subscribeToRunActivity((update) => heard.push(update));

    store.announce(started(LIVE, "first"));
    subscription.unsubscribe();
    store.announce(started(LIVE, "after"));

    expect(heard).toEqual([
      { threadId: THREAD, runId: "first", eventType: "RUN_STARTED" },
    ]);
  });

  test("the store is otherwise the one it was given", () => {
    const store = announcingStore();
    const heard = hearingUnderOwnThreadId(store, {
      threadId: THREAD,
      liveThreadId: LIVE,
    });

    heard.start();

    expect(store.started).toBe(true);
  });
});

describe("in the organization default, where a thread's live id is its own", () => {
  test("an update reaches the chat exactly as it was sent", () => {
    const update = started(THREAD, "run-from-another-tab");

    expect(
      underOwnThreadId(update, { threadId: THREAD, liveThreadId: THREAD }),
    ).toBe(update);
  });

  test("a run started elsewhere on the open thread reaches the chat, as it always has", () => {
    const store = announcingStore();
    const chat = chatListening(THREAD);
    hearingUnderOwnThreadId(store, {
      threadId: THREAD,
      liveThreadId: THREAD,
    }).subscribeToRunActivity((update) => chat.hear(update));

    store.announce(started(THREAD, "run-from-another-tab"));

    expect(chat.pickedUp).toEqual(["run-from-another-tab"]);
  });
});
