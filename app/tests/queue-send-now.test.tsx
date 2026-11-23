import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { ConversationView } from "@/components/channels/conversation-view";
import { problem } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * SEND NOW ON A QUEUED MESSAGE STOPS THE TURN AND SENDS THAT MESSAGE NEXT, ON ITS OWN.
 *
 * Asked for in dogfooding: a message typed while the Bot works is parked as Queued and only goes in
 * once the turn ends, and people want to correct the Bot right now. Send now stops the turn with
 * the same Stop as the button (which keeps what the turn did) and sends that message as the next
 * turn; anything else parked stays parked, in order, and goes after it.
 *
 * Everything here is the real conversation view, composer and transcript. `onSubmit` and `onStop`
 * stand in for the channel: a send that resolves when its turn ends, and a Stop that ends the turn.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = (async () =>
    problem(404, "Not found.")) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const FIRST = "Use the March numbers instead.";
const SECOND = "Stop, compare it with last year first.";

async function queue(
  view: ReturnType<typeof render>,
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(view.getByRole("textbox", { name: "Message" }), text);
  await user.click(view.getByRole("button", { name: "Queue message" }));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: `Remove queued message: ${text}` }),
    ).toBeDefined(),
  );
}

test("Send now stops the turn, sends that message alone next, and keeps the rest queued", async () => {
  const sent: string[] = [];
  const turns: Array<() => void> = [];
  const onSubmit = (draft: ComposerDraft) =>
    new Promise<void>((resolve) => {
      sent.push(draft.text);
      turns.push(resolve);
    });
  let stops = 0;
  let turnRunning = true;
  const props = (busy: boolean) => ({
    channelId: "channel-1",
    messages: [],
    onStop: () => {
      stops += 1;
    },
    onSubmit,
    pending: busy,
    queueWhileBusy: true,
    stoppable: busy,
  });
  const view = render(<ConversationView {...props(turnRunning)} />);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await queue(view, user, FIRST);
  await queue(view, user, SECOND);

  await user.click(
    view.getByRole("button", { name: `Send queued message now: ${SECOND}` }),
  );
  // The turn is stopped, and nothing is sent into the middle of it.
  expect(stops).toBe(1);
  expect(sent).toEqual([]);
  expect(view.getByText("Up next")).toBeDefined();
  expect(
    view.queryByRole("button", { name: `Send queued message now: ${SECOND}` }),
  ).toBeNull();

  // Stop ends the turn: the message Send now was pressed on goes, by itself.
  turnRunning = false;
  view.rerender(<ConversationView {...props(turnRunning)} />);
  await waitFor(() => expect(sent).toEqual([SECOND]));
  // The other one is still waiting, still queued, with both of its controls.
  expect(
    view.getByRole("button", { name: `Remove queued message: ${FIRST}` }),
  ).toBeDefined();
  expect(
    view.getByRole("button", { name: `Send queued message now: ${FIRST}` }),
  ).toBeDefined();
  expect(
    view.queryByRole("button", { name: `Remove queued message: ${SECOND}` }),
  ).toBeNull();

  // And once that turn ends, the rest goes after it.
  turns[0]?.();
  await waitFor(() => expect(sent).toEqual([SECOND, FIRST]));
  turns[1]?.();
  await waitFor(() =>
    expect(
      view.container.querySelector("[aria-label^='Remove queued message']"),
    ).toBeNull(),
  );
  expect(stops).toBe(1);
});

test("Send now after the turn has ended simply sends", async () => {
  const sent: string[] = [];
  let fail = true;
  const onSubmit = async (draft: ComposerDraft) => {
    sent.push(draft.text);
    // The drain fails once, so the queue is held on screen with the Bot idle.
    if (fail) {
      fail = false;
      throw new Error("the turn failed");
    }
  };
  let stops = 0;
  const onStop = () => {
    stops += 1;
  };
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onStop={onStop}
      onSubmit={onSubmit}
      pending
      queueWhileBusy
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await queue(view, user, FIRST);
  view.rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onStop={onStop}
      onSubmit={onSubmit}
      queueWhileBusy
    />,
  );
  await waitFor(() => expect(sent).toEqual([FIRST]));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: `Send queued message now: ${FIRST}` }),
    ).toBeDefined(),
  );

  await user.click(
    view.getByRole("button", { name: `Send queued message now: ${FIRST}` }),
  );
  await waitFor(() => expect(sent).toEqual([FIRST, FIRST]));
  expect(stops).toBe(0);
  await waitFor(() =>
    expect(
      view.container.querySelector("[aria-label^='Remove queued message']"),
    ).toBeNull(),
  );
});

test("Send now before the turn's run can be stopped stops it as soon as it can", async () => {
  let stops = 0;
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onStop={() => {
        stops += 1;
      }}
      onSubmit={async () => undefined}
      pending
      queueWhileBusy
      stoppable={false}
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await queue(view, user, FIRST);
  await user.click(
    view.getByRole("button", { name: `Send queued message now: ${FIRST}` }),
  );
  expect(stops).toBe(0);
  view.rerender(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onStop={() => {
        stops += 1;
      }}
      onSubmit={async () => undefined}
      pending
      queueWhileBusy
      stoppable
    />,
  );
  await waitFor(() => expect(stops).toBe(1));
});

test("Send now is reached from the keyboard", async () => {
  let stops = 0;
  const view = render(
    <ConversationView
      channelId="channel-1"
      messages={[]}
      onStop={() => {
        stops += 1;
      }}
      onSubmit={async () => undefined}
      pending
      queueWhileBusy
      stoppable
    />,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await queue(view, user, FIRST);
  const sendNow = view.getByRole("button", {
    name: `Send queued message now: ${FIRST}`,
  });
  sendNow.focus();
  await user.keyboard("{Enter}");
  expect(stops).toBe(1);
  expect(view.getByText("Up next")).toBeDefined();
});
