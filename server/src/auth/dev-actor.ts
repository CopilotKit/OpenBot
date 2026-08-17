import type { MiddlewareHandler } from "hono";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { AppVariables, AuthenticatedActor } from "./guards";

/**
 * A signed-in person, without signing in. Local development only.
 *
 * Local development can opt into a fixed administrator actor so the product can run without Google
 * OAuth credentials or an interactive consent screen. Hosted deployments must use real
 * authentication.
 *
 * Two independent locks:
 *
 *  1. `OPENBOT_DEV_NO_AUTH=true` must be set. Absent, nothing here runs.
 *  2. `NODE_ENV` must not be `production`. A deployment that sets the flag by accident still refuses,
 *     and it refuses by refusing to start rather than by ignoring the flag, because a
 *     deployment believing it has authentication when it does not is the worst of the three states.
 *
 * The actor is an administrator so admin surfaces can be demonstrated too, and its id is fixed so
 * Intelligence threads and memory stay attached to the same person across restarts.
 */

export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@openbot.local",
  role: "admin",
};

type UserWriter = Pick<Database, "insert">;

export async function initializeDevActorUser(
  database: UserWriter,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;

  const name = DEV_ACTOR.name ?? DEV_ACTOR.email;
  await database
    .insert(users)
    .values({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name,
      emailVerified: false,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: DEV_ACTOR.email,
        name,
        updatedAt: new Date(),
      },
    });

  return true;
}

export function devAuthEnabled(
  environment: Record<string, string | undefined>,
): boolean {
  if (environment.OPENBOT_DEV_NO_AUTH?.trim() !== "true") {
    return false;
  }
  if (environment.NODE_ENV === "production") {
    throw new Error(
      "OPENBOT_DEV_NO_AUTH cannot be used with NODE_ENV=production. Refusing to start without authentication.",
    );
  }
  return true;
}

/** A guard that admits everybody as {@link DEV_ACTOR}. Only ever mounted when devAuthEnabled(). */
export function createDevRequireUser(): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    context.set("actor", DEV_ACTOR);
    await next();
  };
}
