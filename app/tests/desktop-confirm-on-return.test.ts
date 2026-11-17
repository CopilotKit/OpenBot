import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import { connectionsQueryOptions } from "@/lib/plugins/queries";
import { answerAppsApi } from "./apps-api";
import {
  confirmationResponse,
  connectionPage,
  connectionsCall,
  startResponse,
} from "./connections-api";

/**
 * A consent started anywhere in OpenBot Desktop's window is confirmed when the window is back in front.
 *
 * The window sends the app's sign-in to the person's default browser, and that browser comes back to
 * `/desktop-return`, which asks the API nothing. So the window confirms the account itself once it has
 * the focus again, whichever screen it is on: Connections, Browse apps, a conversation. Before this,
 * only the account's own page did, and every list went on saying "Not connected" until somebody
 * opened it. Driven through the connect press a list makes, with a list of connections being read.
 */

const realFetch = globalThis.fetch;
const CONSENT_URL = "https://accounts.example.com/consent?flow=gmail";

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:57221/" }));
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(() => GlobalRegistrator.unregister());

function inDesktopWindow() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    transformCallback: () => 0,
  };
}

/**
 * A deployment where Gmail is consented to: the connect press answers the consent page, and the
 * confirm records the account (the app says yes), so the connections read lists it from then on.
 */
function deployment(options: { authorizesPerAction?: boolean } = {}) {
  const server = { confirms: [] as string[], recorded: false };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = connectionsCall(input, init);
    if (call?.operation === "list")
      return connectionPage(server.recorded ? [{ serverId: "gmail" }] : []);
    if (call?.operation === "connect")
      return startResponse({ authorizationUrl: CONSENT_URL });
    if (call?.operation === "confirm") {
      server.confirms.push(call.appId ?? "");
      server.recorded = true;
      return confirmationResponse(true);
    }
    const apps = answerAppsApi(input, init, {
      composioConfigured: true,
      authorizesPerAction: options.authorizesPerAction ?? false,
      provider: options.authorizesPerAction ? "arcade" : "composio",
    });
    if (apps) return apps;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return server;
}

/** A list of the person's connections on screen, and a Connect pressed from it. */
async function connectFromAList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const list = new QueryObserver(client, connectionsQueryOptions());
  const stop = list.subscribe(() => undefined);
  await waitFor(() =>
    expect(list.getCurrentResult().data?.connections).toEqual([]),
  );
  const start = await new MutationObserver(
    client,
    connectAccountMutationOptions("settings"),
  ).mutate("gmail");
  expect(start).toEqual({ authorizationUrl: CONSENT_URL });
  const listed = () =>
    (list.getCurrentResult().data?.connections ?? []).map(
      (row) => row.serverId,
    );
  return { listed, stop };
}

/** Long enough for anything a focus started to have finished. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("in the Desktop window, a connect started from a list is confirmed once the window is back, and the list shows it", async () => {
  inDesktopWindow();
  const server = deployment();
  const { listed, stop } = await connectFromAList();
  try {
    // Nothing is asked while the person is still in their browser.
    await settle();
    expect(server.confirms).toEqual([]);

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(server.confirms).toEqual(["gmail"]));
    await waitFor(() => expect(listed()).toEqual(["gmail"]));

    // Once per consent: a later focus asks nothing more.
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(server.confirms).toEqual(["gmail"]);
  } finally {
    stop();
  }
});

test("in a browser, coming back to the window confirms nothing: the consent comes back to its own page", async () => {
  const server = deployment();
  const { stop } = await connectFromAList();
  try {
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(server.confirms).toEqual([]);
  } finally {
    stop();
  }
});

test("where each action is authorized on its own, the window leaves the consent to the verifier", async () => {
  inDesktopWindow();
  const server = deployment({ authorizesPerAction: true });
  const { stop } = await connectFromAList();
  try {
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(server.confirms).toEqual([]);
  } finally {
    stop();
  }
});
