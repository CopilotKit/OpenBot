import { expect, test } from "bun:test";
import {
  brokeredAccountsListedOn,
  sharedAccountsListedOn,
} from "@/lib/plugins/listed";
import type { PluginServer } from "@/lib/plugins/queries";

/**
 * The Connected accounts index lists brokered rows from either broker. A deployment holds rows from
 * only one provider, so the browser needs no provider switch: it only needs to recognise "brokered".
 */

function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "App",
    summary: "",
    vendor: "Arcade",
    url: `arcade://${overrides.id}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    tools: [],
    ...overrides,
  } as PluginServer;
}

const ids = (rows: PluginServer[]) => rows.map((row) => row.id);

test("Arcade rows are listed by both functions under the same rules", () => {
  const rows = [
    server({ id: "arcade-gmail" }),
    server({ id: "arcade-noauth", authScheme: "NO_AUTH" }),
    server({ id: "arcade-team", accountMode: "shared" }),
  ];
  expect(ids(brokeredAccountsListedOn(rows))).toEqual(["arcade-gmail"]);
  expect(ids(sharedAccountsListedOn(rows))).toEqual(["arcade-team"]);
});

test("Composio rows are listed exactly as before", () => {
  const rows = [
    server({ id: "composio-gmail", provenance: "composio" }),
    server({
      id: "composio-noauth",
      provenance: "composio",
      authScheme: "NO_AUTH",
    }),
    server({
      id: "composio-team",
      provenance: "composio",
      accountMode: "shared",
    }),
  ];
  expect(ids(brokeredAccountsListedOn(rows))).toEqual(["composio-gmail"]);
  expect(ids(sharedAccountsListedOn(rows))).toEqual(["composio-team"]);
});

test("a row of neither provenance is excluded by both", () => {
  const rows = [
    server({ id: "custom-a", provenance: "custom" }),
    server({ id: "custom-b", provenance: "custom", accountMode: "shared" }),
  ];
  expect(brokeredAccountsListedOn(rows)).toEqual([]);
  expect(sharedAccountsListedOn(rows)).toEqual([]);
});
