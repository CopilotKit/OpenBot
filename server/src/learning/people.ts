import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import { learningPersonSpaces } from "../db/schema/learning";

/** The people who have a Learning space: whose learned Skills an administrator can review, by name. */
export function createLearningPeople(database: Database) {
  const name = sql<string>`coalesce(nullif(trim(${users.name}), ''), ${users.email})`;
  return async (): Promise<
    { userId: string; name: string; containerId: string }[]
  > =>
    database
      .select({
        userId: learningPersonSpaces.userId,
        name,
        containerId: learningPersonSpaces.containerId,
      })
      .from(learningPersonSpaces)
      .innerJoin(users, eq(users.id, learningPersonSpaces.userId))
      .orderBy(asc(name));
}
