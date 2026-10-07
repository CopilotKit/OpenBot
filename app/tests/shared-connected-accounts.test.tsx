// app/tests/shared-connected-accounts.test.tsx
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { useBrokeredAccount } from "../src/components/plugins/brokered-account-row";
import type { PluginServer } from "../src/lib/plugins/queries";
import { brokeredFor } from "../src/routes/_authed/settings/connected-accounts/$key";
import {
  brokeredAccountsListedOn,
  sharedAccountsListedOn,
} from "../src/routes/_authed/settings/connected-accounts/index";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const server = (
  accountMode: "personal" | "shared" | null,
  authScheme = "OAUTH2",
) =>
  ({
    id: `s-${accountMode}`,
    provenance: "composio",
    authScheme,
    accountMode,
  }) as unknown as PluginServer;

describe("Settings for a Shared app", () => {
  test("a Shared app is listed as shared, never as one to connect", () => {
    const servers = [server("personal"), server("shared")];
    expect(brokeredAccountsListedOn(servers).map((row) => row.id)).toEqual([
      "s-personal",
    ]);
    expect(sharedAccountsListedOn(servers).map((row) => row.id)).toEqual([
      "s-shared",
    ]);
  });

  test("the account page does not treat a Shared app as the reader's to confirm", () => {
    expect(brokeredFor(server("shared"))).toBe(false);
    expect(brokeredFor(server("personal"))).toBe(true);
  });

  test("an account that is not brokered here asks nothing of the server on mount", async () => {
    const asked: string[] = [];
    const originalFetch = global.fetch;
    global.fetch = Object.assign(
      async (path: Parameters<typeof fetch>[0]) => {
        asked.push(String(path));
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
    function Probe() {
      useBrokeredAccount({
        serverId: "s-shared",
        brokered: false,
        configured: true,
        recorded: false,
        verified: false,
        verifiedAt: null,
        probe: null,
        checkable: false,
        authScheme: "OAUTH2",
        returnTo: "settings",
        report: () => {},
      });
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      asked.filter((path) => path.endsWith("/connection/confirm")),
    ).toEqual([]);
    global.fetch = originalFetch;
  });
});
