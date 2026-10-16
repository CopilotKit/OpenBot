import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConnectAppCard } from "@/components/channels/connect-app-card";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a Bot's refusal turns into when the app it needed is one this person can connect.
 *
 * What it must never do is navigate this tab. The consent screen belongs to the vendor and the trip
 * is a full page load, so the conversation the person is reading would be replaced by it — and the
 * question they asked would be behind them when they got back.
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

function mounted(connections: { serverId: string; holder?: string }[] = []) {
  const opened: string[] = [];
  (window as unknown as { open: (url: string) => void }).open = (url) => {
    opened.push(url);
  };

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/plugins/connections")) {
      return new Response(JSON.stringify({ connections, redirectUri: null }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/connect") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ authorizationUrl: "https://notion.test/consent" }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(
    <ConnectAppCard
      message="You have not connected your Notion account. Connect it and ask again."
      serverId="srv_notion"
      title="Notion"
    />,
    { wrapper: Wrapper },
  );
  return { opened, view };
}

test("asks for the app by name, in the words the Bot used", () => {
  const card = mounted();

  expect(card.view.getByText(/Connect Notion/)).toBeTruthy();
  expect(
    card.view.getByText(/You have not connected your Notion account/),
  ).toBeTruthy();
});

test("sends the person to the vendor in another tab, never in this one", async () => {
  const card = mounted();
  const before = window.location.href;

  fireEvent.click(card.view.getByRole("button", { name: /^Connect$/ }));

  await waitFor(() =>
    expect(card.opened).toEqual(["https://notion.test/consent"]),
  );
  expect(window.location.href).toBe(before);
  expect(card.view.getByText(/Finish in the tab that opened/)).toBeTruthy();
});

test("says so once the account is actually listed, rather than once they return", async () => {
  const card = mounted([{ serverId: "srv_notion", holder: "person" }]);

  await waitFor(() =>
    expect(card.view.getByText(/Notion is connected/)).toBeTruthy(),
  );
  // No button to press any more: the next step is to ask the Bot again.
  expect(card.view.queryByRole("button", { name: /^Connect$/ })).toBeNull();
});

test("does not read a Shared app's deployment account as this person's", async () => {
  const card = mounted([{ serverId: "srv_notion", holder: "deployment" }]);

  await waitFor(() =>
    expect(card.view.getByRole("button", { name: /^Connect$/ })).toBeTruthy(),
  );
  expect(card.view.queryByText(/Notion is connected/)).toBeNull();
});
