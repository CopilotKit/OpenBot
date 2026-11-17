import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useBotNames } from "@/lib/agents/bot-names";
import { BotListScopeProvider } from "@/lib/agents/list-scope";
import { settleReactWork } from "./settle-react-work";

/**
 * A person's private Bot is theirs alone, so every screen a person reads lists only the Bots they
 * can see, an admin included. Admin's screens decide what every Bot may hold, so they list every Bot
 * in the organization, which the server answers to `scope=organization` for an admin only.
 *
 * Held through `useBotNames`, the names Activity, Audit and the computers page read, as a person's
 * screen draws it and as Admin's layout (`BotListScopeProvider`) draws it.
 */

const realFetch = globalThis.fetch;
let asked: URL[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  asked = [];
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The server: an empty list of Bots, with each request for one kept. */
function serve() {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://openbot.invalid/");
    if (url.pathname.endsWith("/bots")) asked.push(url);
    return new Response(JSON.stringify({ bots: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function Names() {
  useBotNames();
  return null;
}

function draw(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

test("a person's screen lists the Bots they can see, and never asks for every Bot", async () => {
  serve();
  draw(<Names />);
  await waitFor(() => expect(asked).toHaveLength(2));
  for (const url of asked) expect(url.searchParams.has("scope")).toBe(false);
});

test("Admin's screens list every Bot in the organization", async () => {
  serve();
  draw(
    <BotListScopeProvider scope="organization">
      <Names />
    </BotListScopeProvider>,
  );
  await waitFor(() => expect(asked).toHaveLength(2));
  for (const url of asked)
    expect(url.searchParams.get("scope")).toBe("organization");
  // The shown list and the hidden one, both of every Bot.
  expect(asked.map((url) => url.searchParams.get("hidden")).sort()).toEqual([
    null,
    "true",
  ]);
});
