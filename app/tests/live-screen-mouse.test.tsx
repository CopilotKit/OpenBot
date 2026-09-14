import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LiveScreen } from "@/components/computer/live-screen";

/**
 * What a person's click turns into while they hold the wheel.
 *
 * The canvas sends nothing until it knows how large the frames are, because a click has to be mapped
 * from where it landed on screen to where it landed on the page. So each test feeds one frame first.
 * The bitmap decode inside that handler is allowed to fail here — there is no `createImageBitmap`
 * under happy-dom, and the component already treats a frame it cannot draw as one to skip — but the
 * size is recorded before the decode is attempted, which is the part these need.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** The frames Chrome is casting, and the canvas they are drawn on, at the same size. */
const FRAME = { width: 800, height: 600 };

async function liveCanvas(): Promise<{
  canvas: HTMLCanvasElement;
  socket: SocketDouble;
}> {
  const { container } = render(<LiveScreen computerId="mouse-test" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;

  socket.onmessage?.({
    data: JSON.stringify({ type: "frame", data: "AAAA", ...FRAME }),
  });
  await waitFor(() => expect(socket.sent).toEqual([]));

  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: FRAME.width,
      height: FRAME.height,
    }) as DOMRect;
  return { canvas, socket };
}

/** One press and release where the person's browser says this is the nth click there. */
function clickAt(canvas: HTMLCanvasElement, detail: number) {
  const at = { clientX: 40, clientY: 30, button: 0, detail };
  fireEvent.mouseDown(canvas, at);
  fireEvent.mouseUp(canvas, at);
}

test("a double click is sent as a double click", async () => {
  // Chrome fires `dblclick` on the page only when the second press says it is the second, and
  // nothing else does: two presses that both claim to be the first are two separate clicks, so
  // opening a row, expanding a node and selecting a word were all impossible while driving.
  const { canvas, socket } = await liveCanvas();

  clickAt(canvas, 1);
  clickAt(canvas, 2);

  expect(socket.sent.map((message) => message.clickCount)).toEqual([
    1, 1, 2, 2,
  ]);
});

test("an ordinary click is still one click", async () => {
  const { canvas, socket } = await liveCanvas();

  clickAt(canvas, 1);

  expect(socket.sent).toEqual([
    {
      type: "mouse",
      event: "pressed",
      x: 40,
      y: 30,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    },
    {
      type: "mouse",
      event: "released",
      x: 40,
      y: 30,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    },
  ]);
});

test("a press that claims no click at all is still a click", async () => {
  // `detail` is 0 on an event a script dispatched rather than a person, and the computer refuses a
  // press of zero: Chrome then sees a move that happens to have a button set and no click fires.
  const { canvas, socket } = await liveCanvas();

  clickAt(canvas, 0);

  expect(socket.sent.map((message) => message.clickCount)).toEqual([1, 1]);
});

test("moving the mouse is not a click", async () => {
  const { canvas, socket } = await liveCanvas();

  fireEvent.mouseMove(canvas, {
    clientX: 40,
    clientY: 30,
    button: 0,
    detail: 0,
  });

  expect(socket.sent).toEqual([
    {
      type: "mouse",
      event: "moved",
      x: 40,
      y: 30,
      button: "left",
      clickCount: 0,
      modifiers: 0,
    },
  ]);
});
