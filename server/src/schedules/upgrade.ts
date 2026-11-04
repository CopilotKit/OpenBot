/**
 * Moving an existing deployment's schedules and their history into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds its routines, check-ins and responsibilities in its
 * own tables. Each table is copied into its Intelligence collection with the ids, timestamps and state
 * it had, deleted and finished records included, through the collection's `/import` (which leaves a
 * record Intelligence already holds alone). Then the copy checks Intelligence holds every id it sent,
 * and only then records itself in `intelligence_copies` so it never runs again: a record later
 * purged in Intelligence must not come back from the local row this release keeps.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. An import of a record already
 * there changes nothing, so two replicas copying the same table send the same records and the second
 * changes nothing.
 *
 * LOUD ON A MISMATCH. Intelligence holding fewer of the ids than were sent stops the boot with the
 * counts named: running on with part of a person's routines copied would show them a page with
 * routines missing and nothing saying why.
 *
 * Parents first: a run is copied after the routine it belongs to, so a copy that stops halfway never
 * leaves Intelligence with runs of a routine it does not have.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { intelligenceCopies } from "../db/schema";
import type { ScheduleClient } from "./client";
import type { ScheduleCollection } from "./types";

export class ScheduleCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleCopyMismatchError";
  }
}

export type ScheduleCopyStep = {
  /** The name recorded in `intelligence_copies`, e.g. `schedules:routines`. */
  name: string;
  collection: ScheduleCollection;
  /** Every local row, as the record Intelligence imports (wire field names; dates may be `Date`s). */
  read: () => Promise<Record<string, unknown>[]>;
};

export type ScheduleCopyOutcome = {
  name: string;
  kind: "done-before" | "copied";
  local: number;
};

/**
 * Copy each step's table in order. A step already recorded is skipped; the rest are copied, verified
 * and recorded one by one, so a boot that fails halfway resumes at the first unrecorded step.
 */
export async function copyLocalSchedulesToIntelligence(
  database: Database,
  client: Pick<ScheduleClient, "importRecords">,
  steps: readonly ScheduleCopyStep[],
): Promise<ScheduleCopyOutcome[]> {
  const outcomes: ScheduleCopyOutcome[] = [];
  for (const step of steps) {
    const [done] = await database
      .select({ name: intelligenceCopies.name })
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, step.name))
      .limit(1);
    if (done) {
      outcomes.push({ name: step.name, kind: "done-before", local: 0 });
      continue;
    }
    const records = await step.read();
    const stored =
      records.length === 0
        ? 0
        : await client.importRecords(step.collection, records);
    if (stored !== records.length) {
      throw new ScheduleCopyMismatchError(
        `${records.length} ${step.collection} records were to be copied into Intelligence and it holds ${stored} of them. This server will not start with part of them moved; look for the refused records in Intelligence's log.`,
      );
    }
    await database
      .insert(intelligenceCopies)
      .values({ name: step.name, copied: records.length })
      .onConflictDoNothing();
    console.info(
      JSON.stringify({
        type: "schedules-copied-to-intelligence",
        name: step.name,
        collection: step.collection,
        copied: records.length,
      }),
    );
    outcomes.push({ name: step.name, kind: "copied", local: records.length });
  }
  return outcomes;
}
