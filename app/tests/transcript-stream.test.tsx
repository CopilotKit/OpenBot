import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import {
  ChatTranscript,
  messageMode,
} from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * A reply that arrives while the conversation is open is revealed at a steady pace; history is
 * drawn whole, as finished text.
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

const LONG = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");

function frames(count: number) {
  return act(async () => {
    for (let index = 0; index < count; index++) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  });
}

test("history is drawn static, and anything live or still streaming is not", () => {
  expect(messageMode(false, false)).toBe("static");
  expect(messageMode(true, false)).toBe("streaming");
  expect(messageMode(false, true)).toBe("streaming");
});

test("a history message is drawn whole", () => {
  const view = render(
    <ChatTranscript
      messages={[user("u1", "question"), assistant("a1", LONG)]}
      restoring={false}
    />,
  );

  expect(view.container.textContent).toContain(LONG);
});

test("a live reply starts from less than it has and grows to all of it", async () => {
  const history = [user("u1", "question")];
  const view = render(
    <ChatTranscript busy messages={history} restoring={false} />,
  );

  view.rerender(
    <ChatTranscript
      busy
      messages={[...history, assistant("a1", LONG)]}
      restoring={false}
    />,
  );
  expect(view.container.textContent).not.toContain("word59");

  view.rerender(
    <ChatTranscript
      busy={false}
      messages={[...history, assistant("a1", LONG)]}
      restoring={false}
    />,
  );
  await frames(40);

  expect(view.container.textContent).toContain(LONG);
});

/* The run goes on after the reply's last word (drawing an interface, say); that word still shows. */
test("a reply's last word shows while the run is still busy", async () => {
  const history = [user("u1", "question")];
  const text = "here is a chart of your sales:";
  const view = render(
    <ChatTranscript busy messages={history} restoring={false} />,
  );
  view.rerender(
    <ChatTranscript
      busy
      messages={[...history, assistant("a1", text)]}
      restoring={false}
    />,
  );

  await frames(40);

  expect(view.container.textContent).toContain("sales:");
});
