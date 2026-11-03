/**
 * What Intelligence holds about people this deployment no longer has, removed as the old foreign keys
 * removed it.
 *
 * A person's row in `users` used to take with it, by `ON DELETE CASCADE`: their preferences (standing
 * instructions, hidden and pinned Bots, pauses, routing, declined defaults, Team Bot consents), the
 * Team Bot publications they made, the assignments they made, and the skills they owned. Those live in
 * Intelligence now, which knows nothing about this deployment's `users`, so this sweep is that
 * cascade, run by hand: at boot and on a timer, for anybody removed since (a directory deleting them
 * through SCIM, for one).
 *
 * THE ORDER IS THE SAFETY. Intelligence is read first, then `users`. A person is in `users` before
 * anything in Intelligence names them, so an id Intelligence named when it was read, and that is
 * absent from `users` read after, belonged to somebody removed, never to somebody new.
 */
import { inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema/core";
import { ConfigurationMissingError, configurationKey } from "./client";
import type { BotConfiguration } from "./directory";
import type { BotAccessChange } from "./types";

const SWEEP_INTERVAL_MS = 10 * 60 * 1_000;

export async function sweepRemovedPeople(
  database: Database,
  configuration: BotConfiguration,
): Promise<string[]> {
  const client = configuration.client;
  const [preferences, access, skills] = await Promise.all([
    client.preferences.all(),
    client.access.all(),
    client.skills.all(),
  ]);
  const named = new Set<string>([
    ...preferences.map((record) => record.userId),
    ...access.flatMap((record) => [
      ...(record.publication ? [record.publication.publishedBy] : []),
      ...record.assignments.map((assignment) => assignment.assignedBy),
    ]),
    ...skills.flatMap((skill) =>
      skill.ownerUserId === null ? [] : [skill.ownerUserId],
    ),
  ]);
  if (named.size === 0) return [];
  const present = new Set(
    (
      await database
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, [...named]))
    ).map((row) => row.id),
  );
  const gone = new Set([...named].filter((id) => !present.has(id)));
  if (gone.size === 0) return [];

  for (const userId of gone) {
    if (preferences.some((record) => record.userId === userId)) {
      await client.preferences.purge(userId, configurationKey("person-purge"));
      configuration.preferences.forget(userId);
    }
  }
  const changes: BotAccessChange[] = access.flatMap((record) => [
    ...(record.publication && gone.has(record.publication.publishedBy)
      ? [{ op: "unpublish" as const, botId: record.botId }]
      : []),
    ...record.assignments
      .filter((assignment) => gone.has(assignment.assignedBy))
      .map((assignment) => ({
        op: "unassign" as const,
        botId: record.botId,
        group: assignment.group,
      })),
  ]);
  if (changes.length > 0) {
    try {
      await configuration.changeAccess(changes);
    } catch (error) {
      // A Bot purged between the read and now: its access went with it.
      if (!(error instanceof ConfigurationMissingError)) throw error;
      await configuration.access.resync();
    }
  }
  for (const skill of skills) {
    if (skill.ownerUserId === null || !gone.has(skill.ownerUserId)) continue;
    await client.skills.remove(skill.slug, configurationKey("person-skill"));
    configuration.skills.forget(skill.slug);
  }
  console.warn(
    JSON.stringify({
      type: "bot-configuration-people-swept",
      note: "Intelligence named people this deployment no longer has; what was theirs was removed, as the old cascade would have.",
      people: [...gone],
    }),
  );
  return [...gone];
}

/** Run the sweep on a timer. Returns how to stop it. */
export function sweepRemovedPeopleEvery(
  database: Database,
  configuration: BotConfiguration,
  intervalMs = SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    sweepRemovedPeople(database, configuration).catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "bot-configuration-people-sweep-failed",
          note: "The next sweep tries again.",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
