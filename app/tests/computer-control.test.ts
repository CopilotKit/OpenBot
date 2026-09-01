import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  controlLease,
  readControl,
  releaseControl,
  sendHumanInput,
  takeControl,
} from "@/lib/computers/control";

const LEASE = "a".repeat(86);
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);

type SeenRequest = { url: string; init?: RequestInit };

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage(),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) {
    Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

function capture(responses: unknown[]) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return Response.json(responses.shift() ?? {}, { status: 200 });
  }) as typeof fetch;
  return seen;
}

test("only the tab that takes control keeps the returned capability", async () => {
  const seen = capture([
    { holder: "human", since: "now", requested: false, lease: LEASE },
    { holder: "bot", since: "later", requested: false },
  ]);

  const state = await takeControl("codex");
  expect(state).toEqual({ holder: "human", since: "now", requested: false });
  expect(state).not.toHaveProperty("lease");
  expect(controlLease("codex")).toBe(LEASE);

  await releaseControl("codex");
  expect(JSON.parse(String(seen[1]?.init?.body))).toEqual({ lease: LEASE });
  expect(controlLease("codex")).toBeUndefined();
});

test("seeing that a human is driving does not grant this tab their lease", async () => {
  const seen = capture([{ holder: "human", since: "now", requested: false }]);

  expect(await readControl("codex")).toMatchObject({ holder: "human" });
  expect(controlLease("codex")).toBeUndefined();
  sendHumanInput("codex", "click", { x: 10, y: 20 });

  // The GET is the only request. Input without this tab's capability fails closed in the client.
  expect(seen).toHaveLength(1);
});
