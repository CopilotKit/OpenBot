import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createHostAccessBroker } from "../src/host-access/broker";
import {
  createHostAccessRoutes,
  DESKTOP_HOST_OFFLINE,
  NO_DESKTOP_HOST,
} from "../src/host-access/routes";

function appFor(desktopToken: string | null = "desktop-token") {
  const broker = createHostAccessBroker();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/host-access",
    createHostAccessRoutes({
      broker,
      desktopToken: desktopToken ?? undefined,
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
    const { app, broker } = appFor();
    broker.nextDesktopOperation();
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

  test("status says whether this OpenBot has a desktop host at all", async () => {
    expect(
      await (await appFor().app.request("/api/host-access")).json(),
    ).toMatchObject({ desktop: true, connected: false });
    expect(
      await (await appFor(null).app.request("/api/host-access")).json(),
    ).toMatchObject({ desktop: false, connected: false });
  });

  // A server not started by OpenBot Desktop (scripts/start.sh, a container) has no host to ask. The
  // request used to be queued for a desktop that could never poll, and failed two minutes later.
  test("a folder request without a desktop host is refused at once, and nothing is queued", async () => {
    const { app, broker } = appFor(null);
    const response = await app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: "bot-a" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: NO_DESKTOP_HOST });
    expect(broker.statusFor("user-a").pending).toEqual([]);
  });

  test("a folder request while the desktop app is offline is refused at once, and nothing is queued", async () => {
    const { app, broker } = appFor();
    const response = await app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: "bot-a" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: DESKTOP_HOST_OFFLINE });
    expect(broker.statusFor("user-a").pending).toEqual([]);
  });
});
