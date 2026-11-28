import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import type { RoutineReading } from "../src/lib/api/generated/model";
import { readRoutineSentenceMutationOptions } from "../src/lib/routines/mutations";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const PATH = "/api/v2/organizations/default/routines/read";

const vars = {
  botId: "a1",
  sentence: "Every Monday at 9, send the digest",
  timezone: "Europe/Paris",
};

const reading: RoutineReading = {
  outcome: "refused",
  detail: "That needs an app that isn't connected.",
  fix: "connectApp",
};

type Sent = { method: string; path: string; headers: Headers; body: unknown };

/** Records the one request and answers it with `status` and `body`. */
function stub(status: number, body: unknown, contentType = "application/json") {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? "GET",
      path: String(url),
      headers: new Headers(init?.headers),
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
  return sent;
}

function read(input = vars) {
  const options = readRoutineSentenceMutationOptions();
  return options.mutationFn?.(input, {
    client: {} as QueryClient,
    meta: undefined,
  });
}

test("it sends one POST with that body and an Idempotency-Key, and resolves to the reading", async () => {
  const sent = stub(200, reading);
  await expect(read()).resolves.toEqual(reading);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.path).toBe(PATH);
  expect(sent[0]?.body).toEqual(vars);
  expect(sent[0]?.headers.get("Idempotency-Key")).toBeTruthy();
});

test("each call gets a fresh Idempotency-Key", async () => {
  const sent = stub(200, reading);
  await read();
  await read();
  const keys = sent.map((request) => request.headers.get("Idempotency-Key"));
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBeTruthy();
  expect(keys[0]).not.toBe(keys[1]);
});

test("a 503 problem with a detail rejects with that detail", async () => {
  stub(
    503,
    {
      type: "about:blank",
      title: "Service unavailable",
      status: 503,
      detail: "Couldn't reach the model.",
    },
    "application/problem+json",
  );
  await expect(read()).rejects.toThrow("Couldn't reach the model.");
});
