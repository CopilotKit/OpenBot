import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { StillWorkingError } from "@/components/channels/composer/queue";
import { ConversationView } from "@/components/channels/conversation-view";
import { problem } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A MESSAGE TYPED WHILE THE BOT HAS THE TURN IS SENT ONCE IT IS FREE, NEVER HELD WITH NOTHING SAID.
 *
 * Found live: a steer typed into a task's thread just after the task finished showed in the thread
 * and never ran, with no turn and no error. The conversation reads busy a render behind the agent:
 * the screen said the turn was over and drained what was parked, while the agent still had a run
 * under way, so the send was refused before it asked the server anything (`say` in
 * channel-chat.tsx). The drain took that refusal for a failed run and held the queue until the
 * person started a turn themselves, which nothing on screen asked them to do.
 *
 * `onSubmit` here refuses exactly as `say` does while the agent still runs, then sends once it is
 * free; everything above it is the real conversation view and composer.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Nothing here reaches the server: what the view reads on the side is answered Not found.
  globalThis.fetch = (async () =>
    problem(404, "Not found.")) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

test("a parked message whose drain the Bot was still too busy for is sent once the Bot is free", async () => {
  const sent: string[] = [];
  /** The agent's own run, which the screen has not caught up with: busy for the first try. */
  let agentRunning = true;
  const onSubmit = async (draft: ComposerDraft) => {
    if (agentRunning) {
      // The run ends a moment later, as a joined run does.
      setTimeout(() => {
        agentRunning = false;
      }, 100);
      throw new StillWorkingError();
    }
    sent.push(draft.text);
  };
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      // The task's last turn is still being read in, so what is typed now is parked.
      pending
      queueWhileBusy
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Also add a line naming the worst month.",
  );
  await user.click(view.getByRole("button", { name: "Queue message" }));
  await waitFor(() =>
    expect(
      view.container.querySelector("[aria-label^='Remove queued message']"),
    ).not.toBeNull(),
  );

  // The screen reads the turn as over; the agent's run has a moment left.
  view.rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      queueWhileBusy
    />,
  );

  await waitFor(
    () => expect(sent).toEqual(["Also add a line naming the worst month."]),
    { timeout: 3_000 },
  );
  expect(
    view.container.querySelector("[aria-label^='Remove queued message']"),
  ).toBeNull();
});

test("a drain that failed at the server still waits for a turn the person starts", async () => {
  const attempted: string[] = [];
  const onSubmit = async (draft: ComposerDraft) => {
    attempted.push(draft.text);
    throw new Error("the turn failed");
  };
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      pending
      queueWhileBusy
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(view.getByRole("textbox", { name: "Message" }), "Try this.");
  await user.click(view.getByRole("button", { name: "Queue message" }));
  view.rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onSubmit={onSubmit}
      queueWhileBusy
    />,
  );
  await waitFor(() => expect(attempted).toHaveLength(1));
  // Not sent again on its own: a server refusing every request is not retried in a loop.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(attempted).toHaveLength(1);
  expect(
    view.container.querySelector("[aria-label^='Remove queued message']"),
  ).not.toBeNull();
});
