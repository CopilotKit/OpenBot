import { eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { users } from "../db/schema";

export type Profile = { name: string; needsName: boolean };
export type ProfileStore = {
  read(userId: string): Promise<Profile>;
  save(userId: string, name: string): Promise<Profile>;
};

export function createProfileStore(
  database: Pick<Database, "select" | "update">,
): ProfileStore {
  const read = async (userId: string): Promise<Profile> => {
    const [user] = await database
      .select({
        name: users.name,
        email: users.email,
        preferences: users.preferences,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new Error("Your profile could not be found.");
    return {
      name: user.name ?? "",
      needsName:
        user.preferences.profileNameSet !== true &&
        (!user.name?.trim() || user.name === user.email),
    };
  };
  return {
    read,
    async save(userId, name) {
      // Display name only: identity, permissions and conversation ownership never change.
      await database
        .update(users)
        .set({
          name,
          updatedAt: new Date(),
          preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || '{"profileNameSet":true}'::jsonb`,
        })
        .where(eq(users.id, userId));
      return read(userId);
    },
  };
}

const profilePatch = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

export function createProfileRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store?: ProfileStore,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.patch("/", requireUser, async (context) => {
    if (!store)
      return context.json(
        { error: "Profile settings are not available." },
        503,
      );
    const parsed = profilePatch.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return context.json(
        { error: "Enter a name between 1 and 100 characters." },
        400,
      );
    return context.json({
      profile: await store.save(context.var.actor.id, parsed.data.name),
    });
  });
  return app;
}
