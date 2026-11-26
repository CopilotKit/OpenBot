import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import {
  botOperationPath,
  botResponse,
  callbackTokenResponse,
  type SentRequest,
  sentRequest,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot that runs somewhere else gets a key for calling OpenBot's tools back. The key is handed over
 * once, in the answer to issuing it, and the panel shows it until the person says Done; revoking
 * takes it away. Both are writes at the Bot's own address in the API.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** A package-defined id, which stays one segment of the address. */
const BOT = "pkg/expenses";
const TOKEN = "obt_9f2c1e7a4b";

function serving() {
  const writes: SentRequest[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = sentRequest(input, init);
    writes.push(sent);
    if (sent.path === botOperationPath(BOT, "issue-callback-token"))
      return callbackTokenResponse(TOKEN);
    if (sent.path === botOperationPath(BOT, "revoke-callback-token"))
      return botResponse({ id: BOT, hasCallbackToken: false });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
  return writes;
}

function draw(hasToken: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CallbackTokenPanel agentId={BOT} hasToken={hasToken} />
    </QueryClientProvider>,
  );
}

test("generating a key shows it once, and Done puts it away for good", async () => {
  const writes = serving();
  const view = draw(false);
  fireEvent.click(view.getByRole("button", { name: "Generate key" }));
  expect(await view.findByText(TOKEN)).toBeTruthy();
  expect(
    view.getByText("Copy this key now. You won't see it again."),
  ).toBeTruthy();
  expect(writes).toEqual([
    {
      method: "POST",
      path: botOperationPath(BOT, "issue-callback-token"),
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: undefined,
    },
  ]);
  expect(writes[0]?.path).toContain("pkg%2Fexpenses");

  fireEvent.click(view.getByRole("button", { name: "Done" }));
  expect(view.queryByText(TOKEN)).toBeNull();
  expect(view.getByRole("button", { name: "Generate key" })).toBeTruthy();
});

/*
 * A connected Bot gets OpenBot's tools in its conversations over AG-UI and hands each call back for
 * OpenBot to run, with no key. The panel used to tell one with no key that it "can't use tools",
 * right after it had used four of them.
 */
test("a Bot with no key is told it can use OpenBot's tools, and what a key is for", () => {
  const view = draw(false);
  const said = view.container.textContent ?? "";
  expect(said).not.toContain("can't use tools");
  expect(
    view.getByText(
      "This Bot can use OpenBot's tools in its conversations without a key. Generate a key only if your agent calls OpenBot's tools itself.",
    ),
  ).toBeTruthy();
});

test("revoking a key is the API's revoke, with a key of its own", async () => {
  const writes = serving();
  const view = draw(true);
  fireEvent.click(view.getByRole("button", { name: "Revoke key" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes).toEqual([
    {
      method: "POST",
      path: botOperationPath(BOT, "revoke-callback-token"),
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: undefined,
    },
  ]);
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Revoke key" })).toBeTruthy(),
  );
  expect(view.queryByRole("alert")).toBeNull();
});
