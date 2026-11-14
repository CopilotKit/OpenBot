import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * History arriving after a conversation opened must not glide.
 *
 * A conversation opens once its history is in, but history keeps arriving after that: the
 * gateway snapshot can lag the store, so the stored thread merges in after the restore gate
 * lifts (a join still answering at its deadline shows what has arrived so far), a slow voice
 * service delivers its cards late, and a roster re-read can add a turn. When the merge brings a
 * newer user message, the newest person-sent id changes while the conversation is open — which
 * is exactly what the send glide watches for — so the viewport takes `scroll-behavior: smooth`
 * for 700ms and the scroller's move to the end animates through the whole history, from the
 * earliest message to the most recent, every time a long conversation is entered.
 *
 * A send is one row arriving. History arrives in batches. So the glide must only fire when
 * exactly one row arrived with the new id.
 *
 * Harness as in `transcript-open.test.tsx`: one document for the file, cleaned per test.
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

function user(id: string, text: string): Message {
  return { id, role: "user", content: text };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", content: text };
}

function viewport(container: HTMLElement): HTMLElement {
  const element = container.querySelector(
    '[data-slot="message-scroller-viewport"]',
  );
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

test("history merging in after opening does not glide", () => {
  // The gateway snapshot so far: two turns. The conversation opens on it.
  const partial = [user("u1", "one"), assistant("a1", "two")];
  const view = render(<ChatTranscript messages={partial} restoring />);

  view.rerender(<ChatTranscript messages={partial} restoring={false} />);
  expect(viewport(view.container).style.scrollBehavior).toBe("");

  // The stored thread merges in: more turns, with a newer user message last.
  const full = [
    ...partial,
    user("u2", "three"),
    assistant("a2", "four"),
    user("u3", "five"),
    assistant("a3", "six"),
  ];
  view.rerender(<ChatTranscript messages={full} restoring={false} />);

  expect(viewport(view.container).style.scrollBehavior).toBe("");
});

test("a message sent while the conversation is open still glides", () => {
  const history = [user("u1", "one"), assistant("a1", "two")];
  const view = render(<ChatTranscript messages={history} restoring={false} />);
  expect(viewport(view.container).style.scrollBehavior).toBe("");

  view.rerender(
    <ChatTranscript
      messages={[...history, user("u2", "sent just now")]}
      restoring={false}
    />,
  );

  expect(viewport(view.container).style.scrollBehavior).toBe("smooth");
});
