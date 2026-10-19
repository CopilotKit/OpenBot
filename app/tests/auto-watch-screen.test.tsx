import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAutoWatchScreen } from "@/components/computer/use-auto-watch-screen";
import {
  reportComputerActivity,
  withdrawComputerActivity,
} from "@/lib/copilot/computer-activity";
import { settleReactWork } from "./settle-react-work";

/**
 * When a Bot's screen opens itself beside the conversation, and when it closes again.
 *
 * The pane is shared with the Bot's profile and it is the person's pane first: it opens for work
 * they can watch, it does not steal the pane from something they opened, and a run they dismissed
 * stays dismissed until the next one.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function paneFor(options: { watching?: boolean; busy?: boolean } = {}) {
  const opened: number[] = [];
  const closed: number[] = [];
  let watching = options.watching ?? false;
  const view = renderHook(
    (props: { watching: boolean }) =>
      useAutoWatchScreen({
        botId: "bot-1",
        watching: props.watching,
        busy: options.busy ?? false,
        open: () => {
          opened.push(1);
          watching = true;
          view.rerender({ watching });
        },
        close: () => {
          closed.push(1);
          watching = false;
          view.rerender({ watching });
        },
      }),
    { initialProps: { watching } },
  );
  return {
    opened,
    closed,
    /** What closing the pane by hand does: the pane shuts, and this run stops auto-opening. */
    dismiss: () =>
      act(() => {
        view.result.current.dismiss();
        watching = false;
        view.rerender({ watching });
      }),
  };
}

const announce = (botId = "bot-1") => {
  let announcement = 0;
  act(() => {
    announcement = reportComputerActivity(botId);
  });
  return announcement;
};

describe("a Bot reaching its computer", () => {
  test("opens the screen beside the conversation", () => {
    const pane = paneFor();

    announce();

    expect(pane.opened).toHaveLength(1);
  });

  test("does not take a pane the person opened for something else", () => {
    const pane = paneFor({ busy: true });

    announce();

    expect(pane.opened).toHaveLength(0);
  });

  test("does not reopen a screen already being watched", () => {
    const pane = paneFor({ watching: true });

    announce();

    expect(pane.opened).toHaveLength(0);
  });
});

describe("an announcement taken back", () => {
  test("closes the screen it opened", () => {
    const pane = paneFor();
    const announcement = announce();

    act(() => withdrawComputerActivity("bot-1", announcement));

    expect(pane.closed).toHaveLength(1);
  });

  test("leaves a screen some other call opened", () => {
    const pane = paneFor();
    const opening = announce();

    // A later refused call in the same run: its announcement is not the one holding the pane open.
    act(() => withdrawComputerActivity("bot-1", opening + 99));

    expect(pane.closed).toHaveLength(0);
  });

  test("leaves a screen the person was already watching", () => {
    const pane = paneFor({ watching: true });
    const announcement = announce();

    act(() => withdrawComputerActivity("bot-1", announcement));

    // Nothing auto-opened, so there is nothing to take back.
    expect(pane.closed).toHaveLength(0);
  });
});

describe("a run the person dismissed", () => {
  test("does not open again for the rest of it", () => {
    const pane = paneFor();
    announce();
    pane.dismiss();

    announce();

    expect(pane.opened).toHaveLength(1);
  });

  test("stops being dismissed once a new run starts", () => {
    const pane = paneFor();
    announce();
    pane.dismiss();

    // Another Bot acting ends this Bot's run, so its next action is a new one.
    announce("other-bot");
    announce();

    expect(pane.opened).toHaveLength(2);
  });
});

describe("another Bot's computer", () => {
  test("is not this conversation's business", () => {
    const pane = paneFor();

    announce("other-bot");

    expect(pane.opened).toHaveLength(0);
  });
});
