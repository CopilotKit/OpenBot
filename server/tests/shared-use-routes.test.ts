import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createSharedUseRoutes } from "../src/plugins/shared-use-routes";
import { SharedUseRequestDecidedError, type SharedUseStore } from "../src/plugins/shared-use-store";

const request = {
  id: "req1", botId: "bot1", botName: "Triage", ownerUserId: "owner", serverId: "gh", title: "Team GitHub",
  proposed: { audience: "team" as const, outsideInput: false, members: [] }, current: null,
  reason: "refused_call", requestedBy: "u2", status: "pending", createdAt: "2026-10-07T00:00:00.000Z",
};
const decided: string[] = [];
const filed: unknown[] = [];
const fake = {
  listRequests: async () => [request],
  pendingFor: async () => [request],
  decide: async ({ id, decision }: { id: string; decision: string }) => {
    if (decided.includes(id)) throw new SharedUseRequestDecidedError();
    decided.push(id);
    return { ...request, status: decision === "approve" ? "approved" : "declined" };
  },
  fileRequest: async (input: unknown) => {
    filed.push(input);
    return { id: "req2", created: true };
  },
  botFacts: async () => ({ ownerUserId: "owner", visibility: "private" as const, publication: null, assignments: [], sources: ["email"] }),
  sharedAppsHeldBy: async () => [{ serverId: "gh", title: "Team GitHub" }],
  approvalFor: async () => null,
} as unknown as SharedUseStore;

function as(role: "admin" | "user", id: string) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route("/api/approvals/shared-use", createSharedUseRoutes(fake, signedIn, { insert: async () => {} }));
}

describe("shared account requests", () => {
  test("only an administrator lists them", async () => {
    expect((await as("user", "u1").request("/api/approvals/shared-use")).status).toBe(403);
    const body = (await (await as("admin", "a1").request("/api/approvals/shared-use")).json()) as { requests: unknown[] };
    expect(body.requests).toHaveLength(1);
  });

  test("a second decision on the same request is told it was already decided", async () => {
    decided.length = 0;
    const admin = as("admin", "a1");
    expect((await admin.request("/api/approvals/shared-use/req1/approve", { method: "POST" })).status).toBe(200);
    const again = await admin.request("/api/approvals/shared-use/req1/decline", { method: "POST" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "That request has already been decided." });
  });

  test("the owner can ask, and the server decides what is proposed", async () => {
    filed.length = 0;
    const response = await as("user", "owner").request("/api/approvals/shared-use", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot1", serverId: "gh", reason: "trigger", proposed: { audience: "team", outsideInput: true } }),
    });
    expect(response.status).toBe(200);
    expect(filed).toEqual([expect.objectContaining({
      botId: "bot1", serverId: "gh", reason: "trigger", requestedBy: "owner",
      proposed: { audience: "owner", outsideInput: true, members: [] },
    })]);
  });

  test("someone who is neither owner nor admin cannot ask for another person's Bot", async () => {
    const response = await as("user", "stranger").request("/api/approvals/shared-use", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot1", serverId: "gh", reason: "publish" }),
    });
    expect(response.status).toBe(403);
  });

  test("the owner sees what each shared app needs on their Bot", async () => {
    const body = (await (await as("user", "owner").request("/api/approvals/shared-use/bot/bot1")).json()) as {
      apps: { serverId: string; covered: boolean }[];
    };
    expect(body.apps).toEqual([expect.objectContaining({ serverId: "gh", covered: false })]);
  });
});
