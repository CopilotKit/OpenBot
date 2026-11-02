import { expect, test } from "bun:test";
import { connectionRows } from "@/lib/connections/rows";
import type { LinkedAccount } from "@/lib/identity/queries";
import type { CatalogueItem, PluginServer } from "@/lib/plugins/queries";

/**
 * The one list on Connections: apps, apps on the organisation's account, and the GitHub and Slack
 * links, as rows of the same kind, with what is already in use first.
 */

const drive = {
  key: "google-drive",
  title: "Google Drive",
  summary: "Files in your Drive.",
  auth: "user-oauth",
} as CatalogueItem;

const app = (id: string, title: string, provenance = "composio") =>
  ({
    id,
    title,
    summary: "",
    logo: null,
    provenance,
  }) as unknown as PluginServer;

const link = (
  provider: "github" | "slack",
  status: LinkedAccount["status"] = "active",
): LinkedAccount => ({
  id: `link-${provider}`,
  provider,
  title: provider,
  handle: "dana",
  status,
  createdAt: "2026-10-01T00:00:00Z",
});

const none = {
  catalogue: [],
  brokered: [],
  shared: [],
  connected: new Set<string>(),
  links: [],
  providers: { github: false, slack: false },
};

test("apps, team apps and account links are one list, in use first", () => {
  const rows = connectionRows({
    ...none,
    catalogue: [drive],
    brokered: [app("composio-gmail", "Gmail")],
    shared: [app("composio-linear", "Linear")],
    connected: new Set(["composio-gmail"]),
    providers: { github: true, slack: false },
  });
  expect(rows.map((row) => [row.key, row.state])).toEqual([
    ["composio-gmail", "connected"],
    ["composio-linear", "team"],
    ["google-drive", "available"],
    ["github", "available"],
  ]);
});

test("a link this deployment cannot make is not offered", () => {
  const rows = connectionRows({ ...none });
  expect(rows).toEqual([]);
});

test("a link already made is listed even where it can no longer be made, by its handle", () => {
  const rows = connectionRows({ ...none, links: [link("slack")] });
  expect(rows).toEqual([
    expect.objectContaining({
      key: "slack",
      state: "connected",
      summary: "@dana",
    }),
  ]);
});

test("a link the provider stopped accepting asks to be reconnected", () => {
  const rows = connectionRows({
    ...none,
    links: [link("github", "needs_reconnect")],
  });
  expect(rows[0]?.state).toBe("needs_reconnect");
});

test("GitHub is listed once: the Composio GitHub app goes behind GitHub's own page", () => {
  const brokered = [
    app("composio-github", "GitHub"),
    app("composio-gmail", "Gmail"),
  ];
  expect(
    connectionRows({
      ...none,
      brokered,
      providers: { github: true, slack: false },
    }).map((row) => row.key),
  ).toEqual(["composio-gmail", "github"]);
  // Without the GitHub link on offer, the Composio app is the only GitHub there is, so it stays.
  expect(connectionRows({ ...none, brokered }).map((row) => row.key)).toEqual([
    "composio-github",
    "composio-gmail",
  ]);
});

test("and the same for Arcade's GitHub app, which is the same vendor through the other broker", () => {
  expect(
    connectionRows({
      ...none,
      brokered: [
        app("arcade-github", "GitHub", "arcade"),
        app("arcade-gmail", "Gmail", "arcade"),
      ],
      providers: { github: true, slack: false },
    }).map((row) => row.key),
  ).toEqual(["arcade-gmail", "github"]);
});
