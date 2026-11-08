import {
  ACTION_ENDINGS,
  CALLS_RECORDED_AS_CHANGES,
  OPENBOT_WORKING_EVENT_TYPES,
} from "@openbot/shared/activity-rows";
import { outcomeForPerson } from "@openbot/shared/approval-outcomes";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { currentEdition } from "../edition";

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

/**
 * Each Bot's actions as the personal edition's Activity page shows them, so the report's figure for a
 * Bot is the number of rows the person finds there for it. Seen on Windows: a report drew "Errand
 * Helper 45" beside an Activity page listing 23 of its rows; the other 22 were choosing tools for a
 * run, which the page leaves out.
 *
 * The same rows the page asks for (`@openbot/shared/activity-rows`): none of OpenBot's own working,
 * each action once (the first row of an action that then failed, was stopped or was refused is not
 * counted, nor a Routines call whose routine change has its own row), and a Bot's rows as its Bot
 * column reads them: the Bot it names, the Bot a row was about (an `agent` target), the Bot an older
 * folder row named as `botId`, and the Bot a routine runs as.
 */
async function personalBotActivity(database: Database, days: number) {
  const window = sql`created_at > now() - make_interval(days => ${days})`;
  const list = (types: readonly string[]) =>
    sql.join(
      types.map((type) => sql`${type}`),
      sql`, `,
    );
  const rows = await database.execute<{ bot: string; actions: number }>(
    sql`with ended as (
          select payload->>'attempt' as attempt
          from audit_events
          where ${window}
            and event_type in (${list(ACTION_ENDINGS)})
            and jsonb_typeof(payload->'attempt') = 'string'
        )
        select bot, count(*)::int as actions
        from (
          select coalesce(
                   case when jsonb_typeof(payload->'bot') = 'string' then payload->>'bot' end,
                   case when target_type = 'host_access' and jsonb_typeof(payload->'botId') = 'string'
                        then payload->>'botId' end,
                   case when target_type = 'routine' and jsonb_typeof(payload->'agentId') = 'string'
                        then payload->>'agentId' end,
                   case when target_type = 'agent' then target_id end
                 ) as bot
          from audit_events
          where ${window}
            and event_type not in (${list(OPENBOT_WORKING_EVENT_TYPES)})
            and not (
              event_type = 'mcp.call_succeeded'
              and target_id in (${list(CALLS_RECORDED_AS_CHANGES)})
            )
            and not (
              event_type = 'computer.action_allowed'
              and exists (
                select 1 from ended where ended.attempt = audit_events.payload->>'attempt'
              )
            )
        ) shown
        where bot is not null
        group by 1
        order by actions desc
        limit 12`,
  );
  return [...rows];
}

export const DATA_FUNCTIONS: DataFunction[] = [
  {
    name: "botActivity",
    description:
      "How many actions each Bot has taken, counted from the audit trail.",
    reads: "the audit trail",
    async run(database, args) {
      const days = bounded(args.days, { fallback: 7, min: 1, max: 90 });
      if (currentEdition() === "personal")
        return { days, rows: await personalBotActivity(database, days) };
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
      // A person's denial carries the sentence the Bot was told; a component shows it to a person.
      return {
        rows: [...rows].map((row) => ({
          ...row,
          reason: row.reason === null ? null : outcomeForPerson(row.reason),
        })),
      };
    },
  },
];

/**
 * What a component is told, and the person reads on its card, when it may not read a function.
 *
 * In the team edition an admin gives a component its data, so the refusal says so. The personal
 * edition has no admin: the person owns everything these read, and OpenBot gives its own components
 * what they read when they arrive (`PERSONAL_GRANTED_BY` in `routes.ts`). There a refusal is
 * OpenBot's fault, and it never sends the person to an admin they don't have.
 */
export function functionRefusal(
  component: string,
  functionName: string,
): string {
  return currentEdition() === "personal"
    ? "It can't read the data it needs."
    : `${component} can't use the function ${functionName}. An admin has to give it to this component.`;
}

export function dataFunction(name: string): DataFunction | undefined {
  return DATA_FUNCTIONS.find((entry) => entry.name === name);
}
