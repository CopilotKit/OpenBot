import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { LiveScreen } from "@/components/computer/live-screen";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
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

let screen: HTMLCanvasElement;

/**
 * The screen connected and holding the keyboard, as it is once the person has clicked it: every key below is aimed at
 * it, as the browser aims a key at the element with the focus.
 */
async function liveSocket(): Promise<SocketDouble> {
  render(<LiveScreen computerId="keyboard-test" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  screen = document.querySelector("canvas") as HTMLCanvasElement;
  await waitFor(() => expect(screen.dataset.connected).toBe("true"));
  screen.focus();
  expect(document.activeElement).toBe(screen);
  return SocketDouble.latest as SocketDouble;
}

for (const [name, modifier] of [
  ["Ctrl+V", { ctrlKey: true }],
  ["Cmd+V", { metaKey: true }],
] as const) {
  test(`${name} stays in the local page so it can produce a paste event`, async () => {
    const socket = await liveSocket();
    const shortcut = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    screen.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);
  });
}

/*
 * A layout that writes another script has no key that writes a V. Ctrl and the V key report "м" on
 * Russian and "ω" on Greek, with `code` still `KeyV`, so reading `key` alone sent the shortcut to the
 * remote browser and stopped the local paste event that carries the clipboard text.
 */
for (const [layout, written] of [
  ["Russian", "м"],
  ["Greek", "ω"],
] as const) {
  test(`Ctrl+V on a ${layout} layout stays in the local page too`, async () => {
    const socket = await liveSocket();
    const shortcut = new KeyboardEvent("keydown", {
      key: written,
      code: "KeyV",
      keyCode: 86,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    screen.dispatchEvent(shortcut);
    screen.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: written,
        code: "KeyV",
        keyCode: 86,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(socket.sent).toEqual([]);
    expect(shortcut.defaultPrevented).toBe(false);
  });
}

test("Ctrl on a key that writes V on Dvorak is still paste, and Ctrl on the QWERTY V key is not", async () => {
  const socket = await liveSocket();
  // On Dvorak the key that writes V is the one QWERTY calls Period.
  const paste = new KeyboardEvent("keydown", {
    key: "v",
    code: "Period",
    keyCode: 86,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  // And the key QWERTY calls V writes K.
  const other = new KeyboardEvent("keydown", {
    key: "k",
    code: "KeyV",
    keyCode: 75,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  screen.dispatchEvent(paste);
  screen.dispatchEvent(other);

  expect(paste.defaultPrevented).toBe(false);
  expect(other.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "k",
      code: "KeyV",
      text: "k",
      windowsVirtualKeyCode: 75,
      modifiers: 2,
    },
  ]);
});

test("a paste keyup stays local when the modifier was released first", async () => {
  const socket = await liveSocket();
  screen.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  screen.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "v",
      code: "KeyV",
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([]);
});

test("a period carries the browser's virtual key code to the remote screen", async () => {
  const socket = await liveSocket();
  screen.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ".",
      code: "Period",
      keyCode: 190,
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: ".",
      code: "Period",
      text: ".",
      windowsVirtualKeyCode: 190,
      modifiers: 0,
    },
  ]);
});

test("Ctrl+A remains a remote keyboard shortcut", async () => {
  const socket = await liveSocket();
  const shortcut = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  screen.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    },
  ]);
});

test("Command+A on a Mac reaches the Bot's Linux browser as Control+A", async () => {
  const socket = await liveSocket();
  screen.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Meta",
      code: "MetaLeft",
      keyCode: 91,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  screen.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      modifiers: 2,
    },
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    },
  ]);
});

test("the paste event sends clipboard text without forwarding it through a key event", async () => {
  const socket = await liveSocket();
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "." },
  });

  screen.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([{ type: "text", text: "." }]);
});

/*
 * The screen takes the keys it has the focus for, and no others. It used to take every key on the window that was not
 * aimed at a text field, so the Browser page's tab strip never heard an arrow, no button took Enter or Space, Tab left
 * nothing, and every one of those keys went to the person's browser instead.
 */
test("a key aimed at one of the page's own controls is that control's, and nothing reaches the browser", async () => {
  const socket = await liveSocket();
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  for (const key of ["ArrowLeft", "Tab", "Enter", " ", "Delete"]) {
    const press = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(press);
    button.dispatchEvent(
      new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }),
    );
    expect(press.defaultPrevented).toBe(false);
  }
  expect(socket.sent).toEqual([]);
  button.remove();
});

test("a key that went down to the browser goes up there too, after the focus has left the screen", async () => {
  const socket = await liveSocket();
  screen.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Shift",
      code: "ShiftLeft",
      keyCode: 16,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  screen.blur();
  document.body.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Shift",
      code: "ShiftLeft",
      keyCode: 16,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
      modifiers: 8,
    },
    {
      type: "key",
      event: "up",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
      modifiers: 0,
    },
  ]);
});

test("Escape takes the keyboard off the screen and is never sent, so Tab reaches the rest of the page again", async () => {
  const socket = await liveSocket();
  const leave = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  });
  screen.dispatchEvent(leave);
  expect(document.activeElement).not.toBe(screen);
  // Not stopped: a full-size view of a Bot's screen closes on the same Escape.
  expect(leave.defaultPrevented).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("the screen is a stop in the Tab order only while it takes input", async () => {
  render(<LiveScreen computerId="watching-test" driving={false} />);
  const watching = document.querySelector("canvas") as HTMLCanvasElement;
  expect(watching.hasAttribute("tabindex")).toBe(false);
  cleanup();
  await liveSocket();
  expect(screen.getAttribute("tabindex")).toBe("0");
  expect(screen.getAttribute("role")).toBe("application");
});

/*
 * A key still down when the keyboard stops being forwarded: its release used to be dropped with the listeners, and a
 * Shift or a Control left down in the remote browser changed every key and click after it.
 */
test("a key still down when control is handed back, or the screen closes, is released in the remote browser", async () => {
  const shift = {
    type: "key",
    event: "down",
    key: "Shift",
    code: "ShiftLeft",
    windowsVirtualKeyCode: 16,
    modifiers: 8,
  };
  const press = (target: HTMLElement) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Shift",
        code: "ShiftLeft",
        keyCode: 16,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  const released = {
    type: "key",
    event: "up",
    key: "Shift",
    code: "ShiftLeft",
    windowsVirtualKeyCode: 16,
    modifiers: 0,
  };

  // Control handed back with Shift held.
  const view = render(<LiveScreen computerId="handback-test" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;
  const canvas = document.querySelector("canvas") as HTMLCanvasElement;
  await waitFor(() => expect(canvas.dataset.connected).toBe("true"));
  canvas.focus();
  press(canvas);
  view.rerender(<LiveScreen computerId="handback-test" driving={false} />);
  expect(socket.sent).toEqual([shift, released]);
  cleanup();

  // The screen closed with Shift held: released before its socket goes.
  const again = await liveSocket();
  press(screen);
  cleanup();
  expect(again.sent).toEqual([shift, released]);
  expect(again.readyState).toBe(SocketDouble.CLOSED);
});
