import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

/**
 * The data a component may fetch for itself, instead of being handed figures by a model.
 *
 * A component fetches its own data because a component drawn from the model's arguments alone means
 * every number on screen is a number a model produced. For a chart of revenue that is a
 * hallucination with axes. Here the model passes a query, which report, over how many days, and the
 * figures come from this deployment. The model never sees them and cannot invent them.
 *
 * The allow-list is enforced on the server, not in the browser. A compiled React component has
 * the whole application: it can call `fetch` itself, so a list of permitted functions held beside it
 * is documentation, not a control. The only place a permission can be enforced is the place that
 * holds the data. `useSandboxFunctions` is the browser-side equivalent for code running in an
 * isolated frame, which is a different path.
 *
 * Arguments are checked here too, for the same reason: whatever the browser sends is a claim.
 * Bounded rather than merely parsed, a report is a thing somebody watches load, so "how many days"
 * has a ceiling instead of trusting a number that arrived over the wire.
 *
 * These read the trail directly.
 *
 * What these read. A fresh deployment has no connector and no documents, so the worked example reads
 * the one dataset that is always real and always present: this deployment's own audit trail. The seam
 * is the point, a function that reads a customer's connector is another entry in this list, and
 * nothing above it changes.
 */

export type DataFunction = {
  name: string;
  /** What an administrator granting it needs to know. Never read by a model. */
  description: string;
  /** What it reads, in a few words, for the Admin page and for the audit row. */
  reads: string;
  run: (database: Database, args: Record<string, unknown>) => Promise<unknown>;
};

/** A whole number from an untrusted body, clamped into a range it is safe to run. */
function bounded(
  value: unknown,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const DATA_FUNCTIONS: DataFunction[] = [
  {
    name: "botActivity",
    description:
      "How many actions each Bot has taken, counted from the audit trail.",
    reads: "the audit trail",
    async run(database, args) {
      const days = bounded(args.days, { fallback: 7, min: 1, max: 90 });
      // Counted in the database rather than fetched and counted here: the trail is the one table that
      // grows without limit, and a component asking for a chart must not pull a year of it across the
      // wire in order to add up seven days.
      const rows = await database.execute<{ bot: string; actions: number }>(
        sql`select payload->>'bot' as bot, count(*)::int as actions
            from audit_events
            where payload->>'bot' is not null
              and created_at > now() - make_interval(days => ${days})
            group by 1
            order by actions desc
            limit 12`,
      );
      return { days, rows: [...rows] };
    },
  },
  {
    name: "recentRefusals",
    description:
      "The most recent things this deployment refused, and the reason each was refused.",
    reads: "the audit trail",
    async run(database, args) {
      const limit = bounded(args.limit, { fallback: 10, min: 1, max: 50 });
      const rows = await database.execute<{
        at: string;
        bot: string | null;
        what: string;
        reason: string | null;
      }>(
        sql`select created_at as at,
                   payload->>'bot' as bot,
                   event_type as what,
                   coalesce(payload->>'reason', payload->'decision'->>'rule') as reason
            from audit_events
            where event_type in (
              'computer.action_refused',
              'component.refused',
              'component.function_refused',
              'bot.declined'
            )
            order by created_at desc
            limit ${limit}`,
      );
      return { rows: [...rows] };
    },
  },
];

export function dataFunction(name: string): DataFunction | undefined {
  return DATA_FUNCTIONS.find((entry) => entry.name === name);
}
