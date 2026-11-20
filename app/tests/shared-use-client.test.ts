import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accountModePreview } from "../src/lib/apps/mutations";
import { grantPlugin } from "../src/lib/plugins/mutations";
import { personalConnections } from "../src/lib/plugins/queries";
import { describeApproval } from "../src/lib/plugins/shared-use";
import { appPath } from "./apps-api";

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
        mode: "shared",
        applied: false,
        accountsEnded: { holder: "person", count: 3 },
        bots: [],
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
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
  });

  test("sends no approval key when there is none", async () => {
    await grantPlugin({ kind: "mcp", ref: "gh/X", agentId: "b" });
    expect(sent[0]?.body).toEqual({});
  });
});

describe("accountModePreview", () => {
  test("asks without confirming", async () => {
    const preview = await accountModePreview("gh", "shared");
    expect(sent[0]).toEqual({
      path: `${appPath("gh")}/account-mode`,
      method: "PUT",
      body: { mode: "shared", validateOnly: true },
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

  test("calls a team by its name, never its id, and says when one is gone", () => {
    const approval = {
      audience: "people" as const,
      outsideInput: true,
      members: [
        { kind: "team" as const, value: "team_1" },
        { kind: "team" as const, value: "team_2" },
        { kind: "team" as const, value: "team_gone" },
      ],
    };
    expect(
      describeApproval(approval, [
        { id: "team_1", name: "Support" },
        { id: "team_2", name: "Field Sales" },
      ]),
    ).toBe(
      "The teams Support, Field Sales and a team that no longer exists, and outside input",
    );
    // Before the organization's teams have arrived, only how many is known.
    expect(describeApproval(approval)).toBe("3 teams, and outside input");
  });
});
