import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { SharedUseStore } from "../src/plugins/shared-use-store";
import { createTeamBotRoutes } from "../src/team-bots/routes";
import type { TeamBots } from "../src/team-bots/team-bots";

const fakeTeamBots = {
  publish: async () => {},
} as unknown as TeamBots;

const fakeSharedUse = {
  shortfall: async () => [{ serverId: "gh", title: "Team GitHub" }],
} as unknown as SharedUseStore;

function as(role: "admin" | "user", id: string) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route(
    "/api/team-bots",
    createTeamBotRoutes(fakeTeamBots, signedIn, fakeSharedUse),
  );
}

describe("team-bots", () => {
  test("team-bots: publishing a Bot that uses a shared app says what needs approval", async () => {
    const response = await as("user", "owner").request(
      "/api/team-bots/bot1/publication",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: "team", emails: [], groups: [] }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sharedApps: { needsApproval: { serverId: string; title: string }[] };
    };
    expect(body.sharedApps.needsApproval).toEqual([
      { serverId: "gh", title: "Team GitHub" },
    ]);
  });
});
