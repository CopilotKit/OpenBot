import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRoutineRoutes } from "../src/routines/routes";
import type { RoutineStore } from "../src/routines/store";

/**
 * Who may do what with a routine, and who may do what with a door onto the public internet.
 *
 * The two halves of this file are guarded differently and the difference is the point. A routine is
 * somebody's own work, so every route for one is scoped to the person asking. A webhook trigger is a
 * URL a stranger can call, which is a fact about the deployment rather than about whoever typed it,
 * so those routes want an administrator and are not scoped to a creator at all.
 *
 * Worth a test rather than a comment, because the failure is silent in both directions: a surface
 * that admits everybody looks exactly like one that does not until somebody tries, and a page that
 * shows one person's triggers looks exactly like one showing every trigger when a deployment has
 * only ever had one.
 */

function signedInAs(
  id: string,
  role: "user" | "admin",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id,
      email: `${id}@openbot.test`,
      role,
    });
    await next();
  };
}

/** Only what these routes reach for. A fuller fake would only be more to keep true. */
function fakeStore() {
  const created: { name: string; ownerUserId: string }[] = [];
  const store = {
    list: async () => [],
    listTriggers: async () => [
      { id: "trigger-1", name: "Somebody else's", ownerUserId: "another" },
    ],
    get: async (id: string, ownerUserId: string) =>
      ownerUserId === "owner" ? { id, name: "Overnight alerts" } : null,
    createTrigger: async (input: { name: string; ownerUserId: string }) => {
      created.push({ name: input.name, ownerUserId: input.ownerUserId });
      return {
        trigger: { id: "trigger-2", name: input.name },
        secret: "obw_the_only_time_this_exists",
      };
    },
    deleteTrigger: async () => true,
  } as unknown as RoutineStore;
  return { store, created };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("a routine belongs to the person who wrote it", () => {
  test("an ordinary user reaches their own routines", async () => {
    const { store } = fakeStore();
    const routes = createRoutineRoutes(
      store,
      undefined,
      signedInAs("owner", "user"),
    );

    expect((await routes.request("/")).status).toBe(200);
  });

  /*
   * The switch a person meets when a deployment has ROUTINE_SCHEDULER=off. Refusing in words is the
   * whole reason the routes are mounted without a scheduler: somebody who wrote a routine should be
   * told this deployment is not running them, rather than pressing a button that reports success.
   */
  test("Run now says so when this deployment does not run routines", async () => {
    const { store } = fakeStore();
    const routes = createRoutineRoutes(
      store,
      undefined,
      signedInAs("owner", "user"),
    );

    const response = await routes.request("/routine-1/run", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error:
        "Routines are switched off in this deployment, so nothing can be run.",
    });
  });
});

describe("a trigger belongs to the deployment", () => {
  /*
   * The consequence this prevents: an ordinary user minting a publicly reachable endpoint that sets
   * a Bot working, through an API whose only page they cannot open, and so having nowhere to see or
   * revoke it afterwards.
   */
  test("a signed-in user who is not an administrator cannot see or make one", async () => {
    const { store, created } = fakeStore();
    const routes = createRoutineRoutes(
      store,
      undefined,
      signedInAs("owner", "user"),
    );

    expect((await routes.request("/triggers")).status).toBe(403);
    expect(
      (await routes.request("/triggers", json({ name: "Build finished" })))
        .status,
    ).toBe(403);
    expect(
      (await routes.request("/triggers/trigger-1", { method: "DELETE" }))
        .status,
    ).toBe(403);
    expect(created).toEqual([]);
  });

  test("an administrator sees every door, including ones they did not open", async () => {
    const { store } = fakeStore();
    const routes = createRoutineRoutes(
      store,
      undefined,
      signedInAs("keeper", "admin"),
    );

    const response = await routes.request("/triggers");
    expect(response.status).toBe(200);
    // Not scoped to the administrator asking. An administrator who could see only their own could
    // not shut a door somebody else opened, which is the moment somebody needs to.
    expect(await response.json()).toEqual({
      triggers: [
        { id: "trigger-1", name: "Somebody else's", ownerUserId: "another" },
      ],
    });
  });

  test("a trigger may only be pointed at a routine the administrator owns", async () => {
    const { store, created } = fakeStore();
    const routes = createRoutineRoutes(
      store,
      undefined,
      signedInAs("keeper", "admin"),
    );

    // A routine runs with its owner's authority, so wiring somebody else's to a public URL would be
    // handing out their access without their knowing.
    const refused = await routes.request(
      "/triggers",
      json({ name: "Build finished", routineId: "routine-1" }),
    );
    expect(refused.status).toBe(404);
    expect(created).toEqual([]);
  });

  test("the secret is in the creation response and nowhere else", async () => {
    const { store } = fakeStore();
    const routes = createRoutineRoutes(
      store,
      undefined,
      signedInAs("owner", "admin"),
    );

    const response = await routes.request(
      "/triggers",
      json({ name: "Build finished", routineId: "routine-1" }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      secret: "obw_the_only_time_this_exists",
    });
  });
});
