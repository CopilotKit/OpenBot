import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accountModePreview, grantPlugin } from "../src/lib/plugins/mutations";
import { personalConnections } from "../src/lib/plugins/queries";
import { describeApproval } from "../src/lib/plugins/shared-use";

const originalFetch = global.fetch;
const sent: { path: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push({
        path: String(path),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({
        changed: false,
        preview: {
          mode: "shared",
          wouldRevoke: { holder: "person", count: 3 },
          bots: [],
        },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("grantPlugin", () => {
  test("forwards an approval rather than dropping it", async () => {
    await grantPlugin({
      kind: "mcp",
      ref: "gh/X",
      agentId: "b",
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
    expect(sent[0]?.body).toEqual({
      kind: "mcp",
      ref: "gh/X",
      agentId: "b",
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
  });

  test("sends no approval key when there is none", async () => {
    await grantPlugin({ kind: "mcp", ref: "gh/X", agentId: "b" });
    expect(sent[0]?.body).toEqual({ kind: "mcp", ref: "gh/X", agentId: "b" });
  });
});

describe("accountModePreview", () => {
  test("asks without confirming", async () => {
    const preview = await accountModePreview("gh", "shared");
    expect(sent[0]).toEqual({
      path: "/api/plugins/servers/gh/account-mode",
      method: "PUT",
      body: { mode: "shared", confirm: false },
    });
    expect(preview.wouldRevoke.count).toBe(3);
  });
});

describe("personalConnections", () => {
  test("never counts the deployment's account as yours", () => {
    expect(
      personalConnections([
        { serverId: "a", scope: "", connectedAt: "x", holder: "person" },
        {
          serverId: "b",
          scope: "",
          connectedAt: "x",
          holder: "deployment",
          connected: true,
        },
      ]).map((row) => row.serverId),
    ).toEqual(["a"]);
  });
});

describe("describeApproval", () => {
  test("says who, in plain words", () => {
    expect(
      describeApproval({ audience: "owner", outsideInput: false, members: [] }),
    ).toBe("Only its owner");
    expect(
      describeApproval({ audience: "team", outsideInput: true, members: [] }),
    ).toBe("Everyone, and outside input");
    expect(
      describeApproval({
        audience: "people",
        outsideInput: false,
        members: [
          { kind: "group", value: "platform" },
          { kind: "user", value: "u1" },
        ],
      }),
    ).toBe("The group platform and 1 person");
  });
});
