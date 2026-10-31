import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Tooltip } from "@base-ui/react/tooltip";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TranscriptRail } from "@/components/channels/transcript-rail";
import type { Turn } from "@/components/channels/transcript-turns";
import { settleReactWork } from "./settle-react-work";

/**
 * A rail beside the conversation with a mark per turn: hovering one previews the turn, choosing one
 * goes there, drawing older pages first when the turn is not drawn yet.
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

const TURNS: Turn[] = [
  { id: "u1", index: 0, prompt: "What changed?", reply: "Two things." },
  { id: "u2", index: 2, prompt: "Why?", reply: "Because." },
  { id: "u3", index: 4, prompt: "And now?", reply: "" },
];

function marks(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-slot="rail-mark"]'),
  );
}

test("a mark per turn, named by what the person sent, with the current one marked", () => {
  const view = render(
    <TranscriptRail active="u2" onJump={() => {}} turns={TURNS} />,
  );

  expect(
    marks(view.container).map((mark) => mark.getAttribute("aria-label")),
  ).toEqual(["What changed?", "Why?", "And now?"]);
  expect(
    marks(view.container).map((mark) => mark.getAttribute("aria-current")),
  ).toEqual([null, "true", null]);
});

test("choosing a mark jumps to its turn", () => {
  const onJump = mock((_turn: Turn) => {});
  const view = render(
    <TranscriptRail active="u3" onJump={onJump} turns={TURNS} />,
  );

  fireEvent.click(marks(view.container)[0] as HTMLButtonElement);

  expect(onJump).toHaveBeenCalledWith(TURNS[0]);
});

test("a conversation of one turn has no rail", () => {
  const view = render(
    <TranscriptRail active="u1" onJump={() => {}} turns={TURNS.slice(0, 1)} />,
  );

  expect(view.container.querySelector("nav")).toBeNull();
});

function conversation(turns: number): Message[] {
  return Array.from({ length: turns }, (_, index) => [
    { id: `u${index}`, role: "user", content: `question ${index}` },
    { id: `a${index}`, role: "assistant", content: `answer ${index}` },
  ]).flat() as Message[];
}

function viewport(container: HTMLElement): HTMLElement {
  return container.querySelector(
    '[data-slot="message-scroller-viewport"]',
  ) as HTMLElement;
}

test("jumping to a turn that is not drawn yet draws down to it and stops following", async () => {
  const view = render(
    <ChatTranscript messages={conversation(50)} restoring={false} />,
  );
  expect(view.container.querySelector('[data-message-id="u0"]')).toBeNull();
  // Far from the end once the jump has moved the view up.
  Object.defineProperty(viewport(view.container), "scrollHeight", {
    configurable: true,
    get: () => 5000,
  });

  await act(async () => {
    fireEvent.click(marks(view.container)[0] as HTMLButtonElement);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });

  expect(view.container.querySelector('[data-message-id="u0"]')).not.toBeNull();
  expect(viewport(view.container).getAttribute("data-following")).toBe("false");
});

/*
 * At the end, the highlighted mark is the last turn; choosing it moves nothing, so no scroll would
 * ever pick following up again, and a streaming reply would grow below the fold.
 */
test("jumping to a turn that leaves the view at the end keeps following", async () => {
  const view = render(
    <ChatTranscript messages={conversation(3)} restoring={false} />,
  );

  await act(async () => {
    fireEvent.click(marks(view.container).at(-1) as HTMLButtonElement);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });

  expect(viewport(view.container).getAttribute("data-following")).toBe("true");
});

/*
 * The transcript re-renders on every streamed chunk and rebuilds its turns each time. The rail
 * must not redraw a mark per turn for it: only what a mark shows changing redraws it.
 */
test("the rail does not redraw for turns that are rebuilt but the same", () => {
  const marksDrawn = spyOn(Tooltip, "Root");
  const copy = () => TURNS.map((turn) => ({ ...turn }));
  const onJump = () => {};
  const view = render(
    <TranscriptRail active="u3" onJump={onJump} turns={copy()} />,
  );
  const before = marksDrawn.mock.calls.length;
  expect(before).toBe(TURNS.length);

  view.rerender(<TranscriptRail active="u3" onJump={onJump} turns={copy()} />);
  expect(marksDrawn.mock.calls.length).toBe(before);

  const grown = copy();
  grown[2] = { ...TURNS[2], reply: "Now this." } as Turn;
  view.rerender(<TranscriptRail active="u3" onJump={onJump} turns={grown} />);
  expect(marksDrawn.mock.calls.length).toBe(before + 1);
  marksDrawn.mockRestore();
});
