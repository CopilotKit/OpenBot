import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EVENT_BUDGET_BYTES } from "@openbot/shared/recorder-masking";

type Sent = { id: string; message: { type: string; event: Event } };
type Event = {
  type: string;
  name: string;
  value: {
    transport: string;
    method: string;
    url: string;
    origin: string;
    route: string;
    status: number | null;
    durationMs: number;
    completedAt: number;
    outcome: string;
    request: { headers: Record<string, string>; body: Record<string, unknown> };
    response: {
      url?: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
  };
};

// Bun.serve needs the runtime's own Response, which happy-dom's registration replaces on globalThis.
// The same goes for fetch: happy-dom's Response.clone() pipes through a Node stream that loses the original's body, which
// a browser's clone() does not, so the page's fetch here is the runtime's native one.
const NativeResponse = Response;
const nativeFetch = fetch;
const MiB = 1024 * 1024;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
let server: ReturnType<typeof Bun.serve>;
let sent: Sent[] = [];
let postMessageCalls = 0;
let originalPostMessage: typeof window.postMessage;
let originalFetch: typeof fetch;
let originalSend: XMLHttpRequest["send"];
let originalOpen: XMLHttpRequest["open"];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const json = (body: string) =>
        new NativeResponse(body, {
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/small")
        return json(JSON.stringify({ ok: true, note: "hello" }));
      if (url.pathname === "/forty")
        return json(
          JSON.stringify({ password: "hunter22", rows: "x".repeat(40 * 1024) }),
        );
      if (url.pathname === "/three")
        return new NativeResponse("a".repeat(3 * MiB), {
          headers: { "content-type": "text/plain" },
        });
      if (url.pathname === "/png")
        return new NativeResponse(png, {
          headers: { "content-type": "image/png" },
        });
      return new NativeResponse("not found", { status: 404 });
    },
  });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${server.port}/page` });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  await server.stop(true);
});

const hookKey = (name: "configure" | "stop") =>
  Symbol.for(`openbot.recorder.${name}`);
const globals = globalThis as unknown as Record<symbol, unknown>;
const configure = (id: string) =>
  (globals[hookKey("configure")] as (id: string) => void)(id);
const stop = () => (globals[hookKey("stop")] as () => void)();

async function loadHook() {
  // A fresh copy of the script per test, as a newly injected document would run it.
  await import(`../src/main-world/network-hook.ts?run=${crypto.randomUUID()}`);
}

beforeEach(async () => {
  sent = [];
  postMessageCalls = 0;
  originalPostMessage = window.postMessage;
  window.postMessage = ((..._args: unknown[]) => {
    postMessageCalls++;
  }) as typeof window.postMessage;
  globalThis.fetch = nativeFetch;
  originalFetch = globalThis.fetch;
  originalOpen = XMLHttpRequest.prototype.open;
  originalSend = XMLHttpRequest.prototype.send;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: (id: string, message: Sent["message"]) => {
        sent.push({ id, message });
        return Promise.resolve();
      },
    },
  };
  await loadHook();
});
afterEach(() => {
  stop();
  window.postMessage = originalPostMessage;
  globalThis.fetch = nativeFetch;
  delete (globalThis as { chrome?: unknown }).chrome;
  delete globals[hookKey("configure")];
  delete globals[hookKey("stop")];
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
async function nextEvent(): Promise<Event> {
  for (let i = 0; i < 200 && sent.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const first = sent[0];
  if (!first) throw new Error("no event was sent");
  return first.message.event;
}

test("one fetch produces one masked network event in the collector's field names", async () => {
  configure("extension-id");
  const response = await fetch(url("/small?token=abc123secretvalue"), {
    headers: { authorization: "Bearer secret", "x-trace": "1" },
  });
  expect(await response.json()).toEqual({ ok: true, note: "hello" });
  const event = await nextEvent();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.id).toBe("extension-id");
  expect(sent[0]?.message.type).toBe("recorder.page-network");
  expect(event.name).toBe("network");
  const value = event.value;
  expect(value.transport).toBe("fetch");
  expect(value.method).toBe("GET");
  expect(value.route).toBe("/small");
  expect(value.status).toBe(200);
  expect(value.outcome).toBe("ok");
  expect(value.url).not.toContain("abc123secretvalue");
  expect(typeof value.durationMs).toBe("number");
  expect(typeof value.completedAt).toBe("number");
  expect(value.request.headers["x-trace"]).toBe("1");
  expect(value.request.headers.authorization).toBe("[redacted]");
  expect(value.response.body.status).toBe("complete");
  expect(value.response.body.text).toContain("hello");
  expect(postMessageCalls).toBe(0);
});

test("a fetch's JSON request body is masked in the page before it is sent anywhere", async () => {
  configure("extension-id");
  await (
    await fetch(url("/small"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secretpw1", note: "kept" }),
    })
  ).text();
  const event = await nextEvent();
  expect(event.value.method).toBe("POST");
  expect(JSON.parse(event.value.request.body.text as string)).toEqual({
    password: "[redacted]",
    note: "kept",
  });
  expect(JSON.stringify(sent)).not.toContain("secretpw1");
});

const bytesOf = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

test("a 40 KB JSON response is masked whole, then cut to fit one Intelligence event", async () => {
  configure("extension-id");
  await (await fetch(url("/forty"))).text();
  const event = await nextEvent();
  const body = event.value.response.body;
  expect(body.status).toBe("truncated");
  expect(bytesOf(event)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  // Masked before the cut: the cut JSON no longer parses, yet its credential-named key is already redacted.
  expect(body.text as string).toContain('"password":"[redacted]"');
  expect(JSON.stringify(sent)).not.toContain("hunter22");
});

test("a 3 MiB response is read to its first 2 MiB, and the event says how large it was", async () => {
  configure("extension-id");
  await (await fetch(url("/three"))).text();
  const event = await nextEvent();
  expect(event.value.response.body).toMatchObject({
    status: "truncated",
    bytes: 3 * MiB,
  });
  expect(bytesOf(sent[0]?.message)).toBeLessThanOrEqual(64 * 1024);
});

test("a PNG arrives unavailable, and the page still reads its bytes", async () => {
  configure("extension-id");
  const response = await fetch(url("/png"));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  expect((await nextEvent()).value.response.body).toEqual({
    status: "unavailable",
    reason: "binary",
  });
});

test("the page's own fetch resolves with the original body and window.postMessage is never called", async () => {
  configure("extension-id");
  const response = await fetch(url("/small"));
  expect(await response.text()).toBe('{"ok":true,"note":"hello"}');
  await nextEvent();
  expect(postMessageCalls).toBe(0);
});

function xhr(
  path: string,
  responseType: XMLHttpRequestResponseType,
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url(path));
    request.setRequestHeader("x-kind", "xhr");
    request.responseType = responseType;
    // The standard throws InvalidStateError for responseText on any other type; happy-dom may not.
    if (responseType !== "" && responseType !== "text")
      Object.defineProperty(request, "responseText", {
        get() {
          throw new DOMException("not text", "InvalidStateError");
        },
      });
    request.onload = () => resolve(request);
    request.onerror = () => reject(new Error("xhr failed"));
    request.send();
  });
}

test("an XHR with responseType json is read from xhr.response, never responseText", async () => {
  configure("extension-id");
  const request = await xhr("/small", "json");
  expect(request.response).toEqual({ ok: true, note: "hello" });
  const event = await nextEvent();
  expect(event.value.transport).toBe("xhr");
  expect(event.value.request.headers["x-kind"]).toBe("xhr");
  expect(event.value.response.body.status).toBe("complete");
  expect(event.value.response.body.text).toBe('{"ok":true,"note":"hello"}');
  expect(postMessageCalls).toBe(0);
});

test("an XHR with responseType text is read through responseText", async () => {
  configure("extension-id");
  const request = await xhr("/small", "text");
  expect(request.responseText).toBe('{"ok":true,"note":"hello"}');
  const event = await nextEvent();
  expect(event.value.transport).toBe("xhr");
  expect(event.value.response.body.text).toBe('{"ok":true,"note":"hello"}');
});

test("before configure and after stop nothing is sent and the originals are in place", async () => {
  expect(globalThis.fetch).toBe(originalFetch);
  await (await fetch(url("/small"))).text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent).toHaveLength(0);

  configure("extension-id");
  expect(globalThis.fetch).not.toBe(originalFetch);
  expect(XMLHttpRequest.prototype.send).not.toBe(originalSend);
  stop();
  expect(globalThis.fetch).toBe(originalFetch);
  expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
  expect(XMLHttpRequest.prototype.send).toBe(originalSend);
  await (await fetch(url("/small"))).text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent).toHaveLength(0);
});

test("a page without chrome.runtime.sendMessage is left alone", async () => {
  delete (globalThis as { chrome?: unknown }).chrome;
  delete globals[hookKey("configure")];
  delete globals[hookKey("stop")];
  await loadHook();
  const before = globalThis.fetch;
  configure("extension-id");
  expect(globalThis.fetch).toBe(before);
});
