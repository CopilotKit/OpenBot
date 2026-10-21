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

test("a Composio deployment's messageless directory failure is the existing sentence, unchanged", async () => {
  expect(await failureMessage("composio")).toBe(
    "Composio's app directory could not be read.",
  );
});

test("an Arcade deployment's messageless directory failure names Arcade and never Composio", async () => {
  const message = await failureMessage("arcade");
  expect(message).toBe("Arcade's app directory could not be read.");
  expect(message).not.toMatch(/composio/i);
});
