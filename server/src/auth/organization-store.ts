import { ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { DEV_ACTOR } from "./dev-actor";
import type { AuthenticatedActor } from "./guards";
import { setRole } from "./roles";

/** Reconcile only an employee verified by the pinned authority; retain existing local history IDs. */
export function organizationUserStore(database: Database) {
  return async (user: AuthenticatedActor) => {
    const [local] = await database
      .insert(users)
      .values({
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      })
      .onConflictDoUpdate({
        target: users.email,
        setWhere: ne(users.id, DEV_ACTOR.id),
        set: {
          email: user.email,
          name: user.name,
          image: user.image,
          updatedAt: new Date(),
        },
      })
      .returning({ id: users.id });
    if (!local || local.id === DEV_ACTOR.id)
      throw new Error(
        "Organization sign-in cannot use the standalone account.",
      );
    await setRole(database, local.id, user.role);
    return { ...user, id: local.id };
  };
}
