import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { normalizeEmail } from "../people/directory/client";
import { people } from "../people/directory/directory";
import type { PersonChanges } from "../people/directory/types";
import { DEV_ACTOR } from "./dev-actor";
import type { AuthenticatedActor } from "./guards";

/**
 * Reconcile only an employee verified by the pinned authority; retain existing local history IDs.
 *
 * The person lives in Intelligence's directory (people/directory): somebody already here by their
 * address keeps their id and has their name, picture and role brought in line; somebody new is made
 * there under the authority's id, and their row here follows from the directory's answer.
 */
export function organizationUserStore(database: Database) {
  return async (user: AuthenticatedActor) => {
    const [local] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, user.email))
      .limit(1);
    if (local?.id === DEV_ACTOR.id || user.id === DEV_ACTOR.id)
      throw new Error(
        "Organization sign-in cannot use the standalone account.",
      );
    if (local) {
      await people().update(local.id, (current) => {
        const changes: PersonChanges = {};
        if (current.email !== normalizeEmail(user.email))
          changes.email = user.email;
        if (current.name !== (user.name ?? null))
          changes.name = user.name ?? null;
        if (current.image !== (user.image ?? null))
          changes.image = user.image ?? null;
        if (current.role !== user.role) changes.role = user.role;
        return Object.keys(changes).length > 0 ? changes : null;
      });
      return { ...user, id: local.id };
    }
    const created = await people().create({
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      image: user.image ?? null,
      emailVerified: false,
      role: user.role,
    });
    return { ...user, id: created.id };
  };
}
