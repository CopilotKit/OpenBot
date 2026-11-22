import { describe, expect, test } from "bun:test";
import type { Import, ReconnectApp } from "@/lib/api/generated/model";
import {
  botList,
  cloudAppFor,
  isNoticeId,
  movedAppNoticeId,
  movedApps,
  movedAppsInView,
} from "@/lib/moves/moved-apps";

/**
 * The rules behind the apps a move to OpenBot Cloud left to connect again: the notice id a dismissal
 * is saved as (it has to be one the server's `NoticeId` accepts, the same on every device), which
 * moves count, and which apps stay in view.
 */

describe("the notice id a moved app is dismissed as", () => {
  test("real app ids become readable ids the server accepts", () => {
    expect(movedAppNoticeId("gmail")).toBe("moved-app-gmail");
    expect(movedAppNoticeId("google-drive")).toBe("moved-app-google-drive");
    expect(movedAppNoticeId("GOOGLECALENDAR")).toBe("moved-app-googlecalendar");
    expect(movedAppNoticeId("my_mcp__server")).toBe("moved-app-my-mcp-server");
    expect(movedAppNoticeId("  Notion (work)  ")).toBe("moved-app-notion-work");
    expect(movedAppNoticeId("3f2c9a1e-7b4d-4c2a-9e8f-1a2b3c4d5e6f")).toBe(
      "moved-app-3f2c9a1e-7b4d-4c2a-9e8f-1a2b3c4d5e6f",
    );
  });

  test("an id too long, or with nothing left once cleaned, still fits and stays its own", () => {
    const long = `mcp_${"a".repeat(80)}`;
    const other = `mcp_${"a".repeat(79)}b`;
    for (const id of [long, other, "日本語アプリ", "___", "x".repeat(54)]) {
      const notice = movedAppNoticeId(id);
      expect(isNoticeId(notice)).toBe(true);
      expect(notice.startsWith("moved-app-")).toBe(true);
    }
    // Cut to fit, two ids that start alike are still two notices.
    expect(movedAppNoticeId(long)).not.toBe(movedAppNoticeId(other));
    expect(movedAppNoticeId("日本語アプリ")).not.toBe(movedAppNoticeId("___"));
    // The same on every device.
    expect(movedAppNoticeId(long)).toBe(movedAppNoticeId(long));
    // The longest id that fits whole is kept whole.
    expect(movedAppNoticeId("x".repeat(54))).toBe(
      `moved-app-${"x".repeat(54)}`,
    );
  });
});

const gmail: ReconnectApp = {
  appId: "gmail",
  appName: "Gmail",
  accountLabel: "sam@example.com",
  botNames: ["Inbox"],
};
const drive: ReconnectApp = { appId: "googledrive", appName: "Google Drive" };

function move(id: string, status: string, reconnect: ReconnectApp[]): Import {
  return {
    id,
    status,
    createdAt: "2026-11-21T10:00:00Z",
    recipientKey: {
      kty: "RSA",
      alg: "RSA-OAEP-256",
      kid: id,
      e: "AQAB",
      n: "x",
    },
    maxBundleBytes: 1,
    maxPartBytes: 1,
    receivedParts: [],
    reconnect,
  } as Import;
}

describe("the apps a move left to connect again", () => {
  test("every finished move counts, each app once, the newest move's entry kept", () => {
    const newer = { ...gmail, accountLabel: "sam@work.example" };
    expect(
      movedApps([
        move("imp_2", "imported", [newer]),
        move("imp_1", "imported", [gmail, drive]),
        move("imp_3", "failed", [{ appId: "slack", appName: "Slack" }]),
        move("imp_4", "importing", [{ appId: "notion", appName: "Notion" }]),
      ]),
    ).toEqual([newer, drive]);
  });

  test("a moved app is the app here added from its directory entry, or the one with its id", () => {
    const here = [
      { id: "composio-gmail", directoryEntryId: "directory:gmail" },
      { id: "google-drive", directoryEntryId: "catalogue:google-drive" },
      { id: "wiki", directoryEntryId: null },
    ];
    expect(cloudAppFor("gmail", here)?.id).toBe("composio-gmail");
    expect(cloudAppFor("google-drive", here)?.id).toBe("google-drive");
    expect(cloudAppFor("wiki", here)?.id).toBe("wiki");
    // Not added here yet.
    expect(cloudAppFor("slack", here)).toBeUndefined();
  });

  test("a connected app is marked, a dismissed one leaves", () => {
    const here = [
      { id: "composio-gmail", directoryEntryId: "directory:gmail" },
    ];
    const cloudIdOf = (appId: string) => cloudAppFor(appId, here)?.id;
    const shown = movedAppsInView(
      [gmail, drive],
      cloudIdOf,
      new Set(["composio-gmail"]),
      ["star-on-github"],
    );
    expect(
      shown.map((app) => [app.appId, app.cloudId, app.reconnected]),
    ).toEqual([
      ["gmail", "composio-gmail", true],
      ["googledrive", null, false],
    ]);
    // Connected as the move named it is not connected here: the app here has another id.
    expect(
      movedAppsInView([gmail], cloudIdOf, new Set(["gmail"]), [])[0]
        ?.reconnected,
    ).toBe(false);
    expect(
      movedAppsInView([gmail, drive], cloudIdOf, new Set(), [
        "moved-app-googledrive",
      ]).map((app) => app.appId),
    ).toEqual(["gmail"]);
  });

  test("the Bots that used it read as a list", () => {
    expect(botList(["Inbox"])).toBe("Inbox");
    expect(botList(["Inbox", "Research"])).toBe("Inbox and Research");
    expect(botList(["Inbox", "Research", "Sales"])).toBe(
      "Inbox, Research and Sales",
    );
  });
});
