import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { COMPOSIO_URL, MCP_SERVER_URL, SCREENSHOTS } from "../harness/config";
import { expect, journeyOf, test } from "../harness/test";

/**
 * CONNECTIONS: what a person's Bots can use, and adding more.
 *
 * Browse apps is Composio's directory, answered by the harness's Composio stub
 * (`harness/composio-stub.ts`), which has the real API's shapes and eight of its real apps. Its
 * consent page stands for the app's own sign-in: no third-party sign-in is ever started, and no
 * real Composio account is touched. That is what lets this journey go past the hand-off, to a
 * connected app, its page, Disconnect and turning it off.
 *
 * The server a person adds by its address is an MCP server aimock serves on this machine
 * (`harness/aimock-server.ts`).
 *
 * Every journey after this one starts where it found things: the app is turned off and the server
 * removed before it ends, because what a person has connected is part of what every Bot is told.
 */

/** A screenshot of a tab other than the journey's page (the sign-in tab), named after it. */
async function tabShot(tab: Page, testInfo: TestInfo, name: string) {
  const folder = join(SCREENSHOTS, journeyOf(testInfo));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `tab-${name}.png`);
  await tab.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(`tab-${name}`, { path, contentType: "image/png" });
}

/** Every request the Composio stub answered this run, and any it had no answer for. */
async function stubJournal() {
  const response = await fetch(`${COMPOSIO_URL}/__stub/journal`);
  return (
    (await response.json()) as {
      entries: { method: string; path: string; handled: boolean }[];
    }
  ).entries;
}

test("a person browses apps, connects Gmail through its sign-in, then disconnects it and turns it off", async ({
  page,
  context,
  shot,
}, testInfo) => {
  const main = page.getByRole("main");

  await test.step("Connections: the apps Bots use and the ones to add", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Connections" }).click();
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Your apps", level: 2 }),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: /^Parallel Search Public-web/ }),
    ).toContainText("On");
    await expect(
      main.getByRole("heading", { name: "Add an app", level: 2 }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: /^Exa Search Public-web/ }),
    ).toContainText("Add");
    await expect(
      main.getByRole("link", { name: /^Browse apps/ }),
    ).toBeVisible();
    await shot("connections");
  });

  await test.step("search the connections", async () => {
    const search = main.getByRole("textbox", { name: "Search connections" });
    await search.fill("firecrawl");
    await expect(
      main.getByRole("button", { name: /^Firecrawl Public-web/ }),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: /^Firecrawl \(API key\)/ }),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: /^Parallel Search Public-web/ }),
    ).toHaveCount(0);
    await shot("search-connections");
    await search.fill("");
    await expect(
      main.getByRole("link", { name: /^Parallel Search Public-web/ }),
    ).toBeVisible();
  });

  const directory = main.getByRole("textbox", { name: "Search apps" });
  const gmail = page.getByTestId("directory-gmail");

  await test.step("Browse apps: search the directory", async () => {
    await main.getByRole("link", { name: /^Browse apps/ }).click();
    await expect(
      page.getByRole("heading", { name: "Browse apps", level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByText("8 apps. Search by name to narrow them."),
    ).toBeVisible();
    await shot("browse-apps");

    await directory.fill("zzzz");
    await expect(main.getByText('No app matches "zzzz".')).toBeVisible();
    await shot("browse-no-match");

    await directory.fill("gmail");
    await expect(main.getByText("2 matches")).toBeVisible();
    await expect(gmail).toContainText("Gmail");
    await expect(gmail).toContainText("4 actions");
    await expect(gmail.getByRole("button", { name: "Add" })).toBeVisible();
    // An app that takes a key, rather than a sign-in, says so before it is added.
    const bigmailer = page.getByTestId("directory-bigmailer");
    await expect(bigmailer).toContainText("Needs a key from Bigmailer");
    await shot("browse-search");
  });

  await test.step("Add Gmail: its sign-in opens in a new tab, and OpenBot stays put", async () => {
    const opened = context.waitForEvent("page");
    await gmail.getByRole("button", { name: "Add" }).click();
    const signIn = await opened;
    await expect(signIn).toHaveURL(new RegExp(`^${COMPOSIO_URL}/link/lk_`));
    await expect(
      signIn.getByRole("heading", { name: "Sign in to Gmail" }),
    ).toBeVisible();
    await tabShot(signIn, testInfo, "gmail-sign-in");

    await expect(page).toHaveURL(/\/connections\/browse\/composio$/);
    await expect(gmail.getByText("Not connected")).toBeVisible();
    await expect(
      gmail.getByRole("button", { name: "Waiting for Gmail…" }),
    ).toBeVisible();
    await expect(gmail.getByRole("status")).toHaveText(
      "Finish signing in to Gmail in the tab that opened.",
    );
    await shot("waiting-for-gmail");

    // Closing the tab without finishing gives up: the row offers Connect again.
    await signIn.close();
    await page.bringToFront();
    await expect(
      gmail.getByRole("button", { name: "Connect Gmail" }),
    ).toBeVisible();
    await expect(gmail.getByText("Not connected")).toBeVisible();
    await shot("sign-in-closed");
  });

  await test.step("Connect Gmail and allow it on the sign-in page", async () => {
    const opened = context.waitForEvent("page");
    await gmail.getByRole("button", { name: "Connect Gmail" }).click();
    const signIn = await opened;
    await signIn.getByRole("button", { name: "Allow" }).click();
    // The sign-in hands back to OpenBot's own page for the app, which records the connection.
    await expect(signIn).toHaveURL(/\/connections\/composio-gmail\?/);
    await expect(
      signIn.getByRole("heading", { name: "Gmail", level: 1 }),
    ).toBeVisible();
    await expect(
      signIn.getByRole("button", { name: "Disconnect" }),
    ).toBeVisible();
    await tabShot(signIn, testInfo, "gmail-connected");
    await signIn.close();

    await page.bringToFront();
    await expect(gmail.getByText("Connected", { exact: true })).toBeVisible();
    await expect(gmail.getByRole("button")).toHaveCount(0);
    await shot("gmail-connected-in-directory");
  });

  await test.step("Gmail is one of your apps, connected", async () => {
    await main.getByRole("button", { name: "Connections" }).click();
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
    const row = main.getByRole("link", { name: "Gmail Connected" });
    await expect(row).toBeVisible();
    await shot("your-apps-gmail");
    await row.click();
  });

  await test.step("its page: on, connected, and its tools", async () => {
    await expect(
      page.getByRole("heading", { name: "Gmail", level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByRole("switch", { name: "Turn Gmail on or off" }),
    ).toBeChecked();
    await expect(
      main.getByText("Signed in with Gmail. Connected."),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Connect another account" }),
    ).toBeVisible();
    await expect(main.getByText("Who am I")).toBeVisible();
    await expect(main.getByText("Delete thread")).toBeVisible();
    await main.getByRole("button", { name: "Refresh tools" }).click();
    await expect(main.getByText("Who am I")).toBeVisible();
    await shot("gmail-page-connected");
  });

  await test.step("Disconnect", async () => {
    await main.getByRole("button", { name: "Disconnect" }).click();
    await expect(main.getByText("Not connected")).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Connect", exact: true }),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: "Disconnect" })).toHaveCount(
      0,
    );
    await shot("gmail-disconnected");
  });

  await test.step("turn Gmail off: it leaves Connections, and Browse apps offers it again", async () => {
    await main.getByRole("switch", { name: "Turn Gmail on or off" }).click();
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
    await expect(main.getByRole("link", { name: /^Gmail/ })).toHaveCount(0);
    await shot("gmail-turned-off");

    await main.getByRole("link", { name: /^Browse apps/ }).click();
    await directory.fill("gmail");
    await expect(gmail.getByRole("button", { name: "Add" })).toBeVisible();
  });

  await test.step("the Composio stub answered every request OpenBot made", async () => {
    const entries = await stubJournal();
    expect(
      entries.filter((entry) => !entry.handled),
      "every Composio request this journey made has an answer in harness/composio-stub.ts",
    ).toEqual([]);
    // The whole round trip went through the stub: an app added, a link minted, an account removed.
    const paths = entries.map((entry) => `${entry.method} ${entry.path}`);
    expect(paths).toContain("POST /api/v3.1/auth_configs");
    expect(paths).toContain("POST /api/v3.1/connected_accounts/link");
    expect(
      paths.some((path) =>
        path.startsWith("DELETE /api/v3.1/connected_accounts/"),
      ),
    ).toBe(true);
  });
});

test("a person adds an MCP server by its address, sees its tools, and removes it", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");

  await test.step("Add server, refused over plain http to the internet", async () => {
    await page.goto("/connections");
    await main.getByRole("button", { name: "Add server" }).click();
    await expect(
      page.getByRole("heading", { name: "Add server", level: 1 }),
    ).toBeVisible();
    await shot("add-server");
    await main.getByRole("textbox", { name: "Name" }).fill("Field Notes");
    await main
      .getByRole("textbox", { name: "Server address" })
      .fill("http://mcp.example.com/mcp");
    await main.getByRole("button", { name: "Add server" }).click();
    await expect(main.getByRole("alert")).toHaveText(
      "Use the server's https address. OpenBot doesn't send your data over plain http.",
    );
    await shot("add-server-refused");
  });

  await test.step("add it by its address: OpenBot lists its tools", async () => {
    await main
      .getByRole("textbox", { name: "Server address" })
      .fill(MCP_SERVER_URL);
    await main.getByRole("button", { name: "Add server" }).click();
    await expect(
      page.getByRole("heading", { name: "Field Notes", level: 1 }),
    ).toBeVisible();
    await expect(main.getByText("Server address")).toBeVisible();
    await expect(main.getByText(MCP_SERVER_URL)).toBeVisible();
    // Its tools, read from the server, by the names OpenBot gives them.
    await expect(
      main.getByText("List field notes", { exact: true }),
    ).toBeVisible();
    await expect(
      main.getByText("Save field note", { exact: true }),
    ).toBeVisible();
    await shot("server-added");
  });

  await test.step("it is one of your apps", async () => {
    await main.getByRole("button", { name: "Connections" }).click();
    await expect(
      main.getByRole("link", { name: /^Field Notes/ }),
    ).toBeVisible();
    await shot("your-apps-field-notes");
    await main.getByRole("link", { name: /^Field Notes/ }).click();
  });

  await test.step("turn it off: it is removed", async () => {
    await main
      .getByRole("switch", { name: "Turn Field Notes on or off" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Connections", level: 1 }),
    ).toBeVisible();
    await expect(main.getByRole("link", { name: /^Field Notes/ })).toHaveCount(
      0,
    );
    await shot("server-removed");
  });
});
