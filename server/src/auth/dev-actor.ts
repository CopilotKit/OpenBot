import type { MiddlewareHandler } from "hono";
import type { SingleUserAccess } from "../config";
import {
  idempotencyKey,
  PersonAlreadyExistsError,
} from "../people/directory/client";
import { type PeopleDirectory, people } from "../people/directory/directory";
import { callerOf, singleUserRefusal } from "../request-trust";
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
 * The actor is an administrator so admin surfaces can be reached too, and its id is fixed so
 * Intelligence threads and memory stay attached to the same person across restarts.
 */

export const DEV_ACTOR: AuthenticatedActor = {
  id: "dev-local-user",
  email: "dev@openbot.local",
  role: "admin",
};

/**
 * Make sure the single-user administrator is a person in Intelligence's directory (people/directory),
 * and so has a row here for everything that names them. Their id never changes.
 */
export async function initializeDevActorUser(
  _database: unknown,
  enabled: boolean,
  /** The deployment's people directory; the process's own unless a test runs several deployments. */
  directory?: PeopleDirectory,
): Promise<boolean> {
  if (!enabled) return false;

  const name = DEV_ACTOR.name ?? DEV_ACTOR.email;
  directory ??= people();
  const held = await directory.client.getPerson(DEV_ACTOR.id);
  if (!held) {
    try {
      await directory.create(
        {
          id: DEV_ACTOR.id,
          email: DEV_ACTOR.email,
          name,
          image: null,
          emailVerified: false,
          role: "admin",
        },
        // Replicas starting at once each try; all but one are told the person already exists.
        idempotencyKey("dev-actor"),
      );
      return true;
    } catch (error) {
      if (!(error instanceof PersonAlreadyExistsError)) throw error;
    }
  }
  await directory.update(DEV_ACTOR.id, (current) =>
    current.email === DEV_ACTOR.email ? null : { email: DEV_ACTOR.email },
  );

  return true;
}

export function singleUserRequested(
  environment: Record<string, string | undefined>,
): boolean {
  return (
    environment.OPENBOT_SINGLE_USER?.trim() === "true" ||
    // The name this had before. Still honoured so an existing .env keeps working.
    environment.OPENBOT_DEV_NO_AUTH?.trim() === "true"
  );
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
  if (singleUserRequested(environment)) return true;

  throw new Error(
    "No identity provider is configured. Set GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_* with BETTER_AUTH_SECRET and BETTER_AUTH_URL, or set OPENBOT_SINGLE_USER=true to run with one administrator and no sign-in. Refusing to start rather than serving a deployment where every visitor is an administrator.",
  );
}

/**
 * A guard that admits as {@link DEV_ACTOR} every request this machine's own person could have made: from
 * this machine where the server runs on it, addressed to one of its own names (`singleUserRefusal`).
 * Only ever mounted when singleUserEnabled().
 *
 * `access` is the deployment's (`config.singleUserAccess`). Absent, the strictest: this machine only.
 */
export function createDevRequireUser(
  access?: SingleUserAccess,
): MiddlewareHandler<{
  Variables: AppVariables;
}> {
  return async (context, next) => {
    const refused = singleUserRefusal(
      context.req.raw,
      callerOf(context),
      access,
    );
    if (refused) return context.json({ error: refused }, 403);
    context.set("actor", DEV_ACTOR);
    await next();
  };
}
