import { expect, test } from "bun:test";
import type { PluginServer } from "@/lib/plugins/queries";
import { brokeredAccountsListedOn } from "@/routes/_authed/settings/connected-accounts/index";

/**
 * Which brokered apps the Connected accounts page lists, decided without drawing anything.
 *
 * The page's own rule for the catalogue half is "only vendors reached as a person": a vendor with a
 * shared token is left off because it "has nothing for you to decide". A Composio `NO_AUTH` app has
 * exactly as little, one layer further in — there is no account to make, `/servers/:id/connect`
 * refuses to create one, and the call gate lets such a call through with no connection row at all —
 * and the brokered filter took every `composio` row regardless.
 *
 * WHAT THAT PUT ON EVERY PERSON'S PAGE was a permanently grey "Not connected" row for an app nobody
 * can connect, which reads as an unfinished task and can never turn green. Clicking it lands on a
 * page that says the app needs no account and draws no button, so the list and the page it opens
 * contradict each other — and the list is the more believable of the two.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `composio-picker.test.tsx`, which exports its own rule as a function for this same reason.
 */

/** A minimal but complete `PluginServer`, overridable per case. */
function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "App",
    summary: "",
    vendor: "Composio",
    url: `composio://${overrides.id}`,
    provenance: "composio",
    authScheme: "API_KEY",
    tools: [],
    ...overrides,
  } as PluginServer;
}

test("a brokered app somebody connects is listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-gmail", authScheme: "OAUTH2" }),
      server({ id: "composio-linear", authScheme: "API_KEY" }),
    ]).map((row) => row.id),
  ).toEqual(["composio-gmail", "composio-linear"]);
});

test("a brokered app that needs no account is not listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-hackernews", authScheme: "NO_AUTH" }),
      server({ id: "composio-gmail", authScheme: "OAUTH2" }),
    ]).map((row) => row.id),
  ).toEqual(["composio-gmail"]);
});

/**
 * AND A ROW WITH NO RECORDED SCHEME IS STILL LISTED, which is the deliberate direction.
 *
 * A brokered row whose column was never written — restored, or made before the column existed — is
 * far likelier to be a key or consent app than a no-auth one, and dropping it here would hide a
 * connection somebody does have from the only page that offers to disconnect it.
 */
test("a brokered app with no recorded scheme is still listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-mystery", authScheme: null }),
    ]).map((row) => row.id),
  ).toEqual(["composio-mystery"]);
});

test("a server that is not brokered at all is never listed", () => {
  expect(
    brokeredAccountsListedOn([
      server({
        id: "internal",
        provenance: "custom",
        url: "https://mcp.example.com/mcp",
        authScheme: null,
      }),
    ]),
  ).toEqual([]);
});
