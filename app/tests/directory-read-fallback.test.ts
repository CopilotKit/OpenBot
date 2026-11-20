import { afterEach, expect, test } from "bun:test";
import { directoryAppsQueryOptions } from "@/lib/apps/queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs the directory query against a failure that carries no server message at all. */
async function failureMessage() {
  globalThis.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const options = directoryAppsQueryOptions("");
  try {
    await (options.queryFn as (ctx: unknown) => Promise<unknown>)({
      signal: new AbortController().signal,
    });
  } catch (thrown) {
    return (thrown as Error).message;
  }
  throw new Error("the query was expected to fail");
}

test("a messageless directory failure is the directory screen's sentence, and names no broker", async () => {
  const message = await failureMessage();
  expect(message).toBe(
    "Couldn't load the apps you can connect. Try again in a moment.",
  );
  expect(message).not.toMatch(/composio|arcade/i);
});
