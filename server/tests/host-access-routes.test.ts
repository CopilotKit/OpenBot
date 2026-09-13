import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createHostAccessBroker } from "../src/host-access/broker";
import { createHostAccessRoutes } from "../src/host-access/routes";

function appFor() {
  const broker = createHostAccessBroker();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/host-access",
    createHostAccessRoutes({
      broker,
      desktopToken: "desktop-token",
      requireUser: async (context, next) => {
        context.set("actor", {
          id: "user-a",
          email: "user@example.test",
          role: "user",
        });
        await next();
      },
      canUseBot: async (actor, botId) =>
        actor.id === "user-a" && botId === "bot-a",
      botName: async () => "Readable Bot Name",
    }),
  );
  return { app, broker };
}

describe("host access routes", () => {
  test("desktop polling is bearer-token authenticated and leases queued operations", async () => {
    const { app, broker } = appFor();
    const grantRequest = broker.requestFolderGrant({
      botId: "bot-a",
      botName: "Bot A",
      actorId: "user-a",
    });

    expect((await app.request("/api/host-access/desktop/next")).status).toBe(
      401,
    );

    const response = await app.request("/api/host-access/desktop/next", {
      headers: { authorization: "Bearer desktop-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      operations: [
        { kind: "choose_folder", botId: "bot-a", actorId: "user-a" },
      ],
    });
    broker.resolveDesktopOperation({
      operationId: body.operations[0].operationId,
      ok: true,
      grant: { grantId: "grant-1", displayName: "Project" },
    });
    await grantRequest;
  });

  test("status includes whether the desktop worker is connected", async () => {
    const { app, broker } = appFor();
    expect(await (await app.request("/api/host-access")).json()).toMatchObject({
      connected: false,
    });
    broker.nextDesktopOperation();
    expect(await (await app.request("/api/host-access")).json()).toMatchObject({
      connected: true,
    });
  });

  test("owner grant requests send the Bot's readable name to native", async () => {
    const { app } = appFor();
    const request = app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: "bot-a" }),
      headers: { "content-type": "application/json" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lease = await app.request("/api/host-access/desktop/next", {
      headers: { authorization: "Bearer desktop-token" },
    });
    const body = await lease.json();
    expect(body.operations[0]).toMatchObject({
      kind: "choose_folder",
      botName: "Readable Bot Name",
    });
    await app.request("/api/host-access/desktop/result", {
      method: "POST",
      headers: {
        authorization: "Bearer desktop-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationId: body.operations[0].operationId,
        ok: true,
        grant: { grantId: "grant-1", displayName: "Project" },
      }),
    });
    expect((await request).status).toBe(200);
  });

  test("owner routes do not let an admin-style caller pick for a Bot they cannot use", async () => {
    const { app } = appFor();
    const denied = await app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: "bot-b" }),
      headers: { "content-type": "application/json" },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({
      error: "That Bot is not available to you.",
    });
  });
});
