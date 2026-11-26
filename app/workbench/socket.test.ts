import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SocketControl } from "../../desktop/workbench/appContract";
import { installFakeSockets } from "./socket";

let control: SocketControl;

beforeAll(() => {
  GlobalRegistrator.register();
  control = installFakeSockets(window);
});
afterAll(() => GlobalRegistrator.unregister());

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function make(url: string): WebSocket {
  const Socket = window.WebSocket as unknown as typeof WebSocket;
  return new Socket(url);
}

test("a socket opens after a microtask", async () => {
  const socket = make("ws://127.0.0.1:3021/api/ws/open-test");
  let opened = 0;
  socket.onopen = () => {
    opened += 1;
  };
  expect(socket.readyState).toBe(WebSocket.CONNECTING);
  expect(socket.binaryType).toBe("blob");
  await tick();
  expect(socket.readyState).toBe(1);
  expect(opened).toBe(1);
  const record = control.sockets().find((s) => s.url.endsWith("open-test"));
  expect(record?.state).toBe("open");
});

test("onmessage and addEventListener both get a sent message", async () => {
  const socket = make("ws://127.0.0.1:3021/api/ws/message-test");
  await tick();
  const byProperty: unknown[] = [];
  const byListener: unknown[] = [];
  socket.onmessage = (event) => byProperty.push(event.data);
  socket.addEventListener("message", (event) =>
    byListener.push((event as MessageEvent).data),
  );
  expect(control.send("message-test", { resync: true })).toBe(1);
  expect(byProperty).toEqual(['{"resync":true}']);
  expect(byListener).toEqual(['{"resync":true}']);
  expect(control.send("message-test", "plain")).toBe(1);
  expect(byProperty).toEqual(['{"resync":true}', "plain"]);
  const record = control.sockets().find((s) => s.url.endsWith("message-test"));
  expect(record?.received).toBe(2);
});

test("send before open throws, and send after open is logged", async () => {
  const socket = make("ws://127.0.0.1:3021/api/ws/send-test");
  expect(() => socket.send("early")).toThrow("Still in CONNECTING state.");
  await tick();
  socket.send("hello");
  const record = control.sockets().find((s) => s.url.endsWith("send-test"));
  expect(record?.sent).toEqual(["hello"]);
});

test("close fires close with the code", async () => {
  const socket = make("ws://127.0.0.1:3021/api/ws/close-test");
  await tick();
  const codes: number[] = [];
  socket.onclose = (event) => codes.push(event.code);
  socket.close(4001, "bye");
  expect(socket.readyState).toBe(2);
  await tick();
  expect(socket.readyState).toBe(3);
  expect(codes).toEqual([4001]);
  socket.send("late");
  const record = control.sockets().find((s) => s.url.endsWith("close-test"));
  expect(record).toMatchObject({ state: "closed", sent: [] });
});

test("control.send counts only matching open sockets, and control.close closes them", async () => {
  const a = make("ws://127.0.0.1:3021/api/ws/channels?a");
  const b = make("ws://127.0.0.1:3021/api/ws/channels?b");
  make("ws://127.0.0.1:3021/api/ws/voice");
  expect(control.send("channels", "x")).toBe(0);
  await tick();
  b.close();
  await tick();
  expect(control.send("channels", "x")).toBe(1);
  let changes = 0;
  const stop = control.onChange(() => {
    changes += 1;
  });
  const closed: number[] = [];
  a.addEventListener("close", (event) =>
    closed.push((event as CloseEvent).code),
  );
  expect(control.close("channels", 4000)).toBe(1);
  await tick();
  expect(closed).toEqual([4000]);
  expect(changes).toBe(1);
  stop();
});
