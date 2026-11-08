import { afterEach, expect, test } from "bun:test";
import { composioAppsQueryOptions } from "@/lib/plugins/queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs the directory query against a failure that carries no server message at all. */
async function failureMessage(provider: "composio" | "arcade") {
  globalThis.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const options = composioAppsQueryOptions("", provider);
  try {
    await (options.queryFn as (ctx: unknown) => Promise<unknown>)({});
  } catch (thrown) {
    return (thrown as Error).message;
  }
  throw new Error("the query was expected to fail");
}

test("a messageless directory failure is the directory screen's sentence, and names no broker", async () => {
  for (const provider of ["composio", "arcade"] as const) {
    const message = await failureMessage(provider);
    expect(message).toBe(
      "Couldn't load the apps you can connect. Reload the page.",
    );
    expect(message).not.toMatch(/composio|arcade/i);
  }
});
