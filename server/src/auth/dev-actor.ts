import type { MiddlewareHandler } from "hono";
import {
  browserIdFromRequest,
  browserUserEmail,
  browserUserId,
} from "../../../shared/browser-identity";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { AppVariables, AuthenticatedActor } from "./guards";

/**
 * A signed-in person, without signing in.
 *
 * A deployment with no identity provider is one administrator and no sign-in, so `bun run dev`
 * reaches the product without registering an OAuth client first. Nobody should have to set up Entra
 * to look at a Bot. `.env.example` ships that line switched on, so a clone still runs with no
 * configuration at all.
 *
 * The lock is the flag and nothing else. It used to be `NODE_ENV`, which is exactly backwards:
 * `NODE_ENV` is unset by default, so the one case it had to catch was the one it let through. A
 * container run on a VM with a hand-written env file and no provider served every visitor on the
 * internet as an administrator, and said nothing, because it looked like it was working. Now the
 * deployment refuses to start unless somebody wrote down that they meant it.
 *
 * The actor is an administrator so admin surfaces can be reached too. When the browser sends a
 * remembered id, that browser is its own person: otherwise every visitor would share one roster.
 * Scripts and tests that send no id still land on this fixed actor, so Intelligence threads that
 * predate the header stay attached.
 */

export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@openbot.local",
  role: "admin",
};

type UserWriter = Pick<Database, "insert">;

const ensuredUserIds = new Set<string>([DEV_ACTOR.id]);

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

export function actorForBrowserId(browserId: string): AuthenticatedActor {
  return {
    id: browserUserId(browserId),
    email: browserUserEmail(browserId),
    name: "Guest",
    role: "admin",
  };
}

/**
 * Who this request is, in single-user mode.
 *
 * A valid browser id is that browser. Anything else is the shared administrator, which is what a
 * curl, a test, and a tab that has not minted an id yet all are.
 */
export function singleUserActorFromRequest(request: {
  headers: { get(name: string): string | null };
  url: string;
}): AuthenticatedActor {
  const browserId = browserIdFromRequest(request);
  return browserId ? actorForBrowserId(browserId) : DEV_ACTOR;
}

/**
 * Channel memberships point at `users.id`, so a browser that has never been seen still needs a row.
 *
 * Remembered in-process so a busy tab is not an insert on every request. A restart upserts on the
 * next call; `onConflictDoNothing` keeps that quiet.
 */
export async function ensureSingleUserActorUser(
  database: UserWriter,
  actor: AuthenticatedActor,
): Promise<void> {
  if (ensuredUserIds.has(actor.id)) return;

  const name = actor.name ?? actor.email;
  await database
    .insert(users)
    .values({
      id: actor.id,
      email: actor.email,
      name,
      emailVerified: false,
    })
    .onConflictDoNothing({ target: users.id });

  ensuredUserIds.add(actor.id);
}

/**
 * Whether this deployment admits everybody as one administrator.
 *
 * Only ever true when no identity provider is configured: a provider always wins, so a deployment
 * cannot half sign people in.
 *
 * @param hasProvider whether any identity provider is configured
 */
export function singleUserEnabled(
  environment: Record<string, string | undefined>,
  hasProvider: boolean,
): boolean {
  if (hasProvider) return false;

  // Said explicitly, which is the only way to run with no sign-in at all. Not a default, and not
  // inferred from anything: every signal that could stand in for "this is only my laptop" is absent
  // by default on a server too, which is what made the previous NODE_ENV check useless.
  const asked =
    environment.OPENBOT_SINGLE_USER?.trim() === "true" ||
    // The name this had before. Still honoured so an existing .env keeps working.
    environment.OPENBOT_DEV_NO_AUTH?.trim() === "true";
  if (asked) return true;

  throw new Error(
    "No identity provider is configured. Set GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or set OPENBOT_SINGLE_USER=true to run with one administrator and no sign-in. Refusing to start rather than serving a deployment where every visitor is an administrator.",
  );
}

/**
 * A guard that admits every visitor. Only ever mounted when singleUserEnabled().
 *
 * Each browser that sends its remembered id is its own person. Without one, this is {@link DEV_ACTOR}.
 */
export function createDevRequireUser(database?: UserWriter): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    const actor = singleUserActorFromRequest(context.req.raw);
    if (database) {
      await ensureSingleUserActorUser(database, actor);
    }
    context.set("actor", actor);
    await next();
  };
}
