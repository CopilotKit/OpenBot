import { auditEventWords } from "@openbot/shared/audit-words";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import { callComponentFunction } from "@/lib/components/queries";
import { useActiveBotId } from "@/lib/copilot/active-bot";
import { useConversation } from "@/lib/copilot/conversation";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { keyedLookup } from "@/lib/lookup";
import { FailedCard, UNREADABLE } from "./failed";
import { GalleryFrame } from "./frame";
import { seriesColour } from "./palette";
import { GalleryDecidedContext, GalleryStreamingContext } from "./streaming";

/**
 * Server-filled report component. The model chooses report arguments; data and permissions come
 * from the deployment.
 */

const TITLE = "Activity report";

export const ActivityReportProps = z.object({
  report: z
    .enum(["activity", "refusals"])
    .describe(
      "Which report to show: 'activity' for how much each Bot has done, 'refusals' for what this deployment recently refused",
    ),
  title: z
    .string()
    .optional()
    .describe("A heading for the report, in a few words"),
  days: z
    .number()
    .optional()
    .describe(
      "For the activity report: how many days back to count. Defaults to 7",
    ),
});

type ActivityArgs = z.infer<typeof ActivityReportProps>;

/**
 * Which server-side function each report reads. Not the model's choice.
 *
 * A Map, read through `keyedLookup`, because the key is a string somebody else chose: an object
 * lookup answers `toString` or `constructor` with a member inherited from `Object.prototype`,
 * which is truthy and so walks straight past the `functionName ?` guards below — handing a
 * function to the grant check as the data function this component reads, and to
 * `callComponentFunction` as a function name.
 */
const FUNCTION_FOR: ReadonlyMap<string, string> = new Map([
  ["activity", "botActivity"],
  ["refusals", "recentRefusals"],
]);

type ActivityRow = { bot: string; actions: number };
type RefusalRow = {
  at: string;
  bot: string | null;
  what: string;
  reason: string | null;
};

type State =
  | { status: "reading" }
  | { status: "refused"; reason: string }
  | { status: "read"; data: unknown };

export function ActivityReportCard({
  report,
  title,
  days,
}: Partial<ActivityArgs>) {
  const botId = useActiveBotId();
  const conversation = useConversation();
  const [state, setState] = useState<State>({ status: "reading" });
  const streaming = useContext(GalleryStreamingContext);
  const decided = useContext(GalleryDecidedContext);

  const functionName = report ? keyedLookup(FUNCTION_FOR, report) : undefined;

  useEffect(() => {
    /*
     * Nothing to read until the arguments are final and the call is allowed. A refused call is drawn
     * as its refusal and never reads, so one try is one row on the trail.
     */
    if (!functionName || streaming || !decided) return;
    let current = true;

    void callComponentFunction(
      "showActivityReport",
      functionName,
      days === undefined ? {} : { days },
      botId,
    ).then((result) => {
      if (!current) return;
      setState(
        result.allowed && result.data !== undefined
          ? { status: "read", data: result.data }
          : {
              status: "refused",
              reason:
                result.reason ?? result.error ?? "Couldn't read that data.",
            },
      );
    });

    return () => {
      current = false;
    };
  }, [functionName, days, botId, streaming, decided]);

  /*
   * No report it can read. While the call streams, the name is still arriving. Once its arguments
   * are final there is nothing to read, and "Choosing" or "Reading" would stay on screen for good.
   */
  if (!functionName) {
    if (!streaming) return <FailedCard reason={UNREADABLE} title={TITLE} />;
    return (
      <GalleryFrame title="Report">
        <p className="text-sm text-muted-foreground">Choosing a report…</p>
      </GalleryFrame>
    );
  }

  if (state.status === "reading") {
    return (
      <GalleryFrame caption="Reading from OpenBot" title={title ?? "Report"}>
        <p className="text-sm text-muted-foreground">Reading…</p>
      </GalleryFrame>
    );
  }

  if (state.status === "refused") {
    return (
      <GalleryFrame title={title ?? "Report"}>
        <p className="text-sm text-destructive">Not shown</p>
        <p className="mt-1 text-sm text-foreground/80">{state.reason}</p>
      </GalleryFrame>
    );
  }

  return report === "activity" ? (
    <ActivityChart
      ask={conversation?.ask}
      data={state.data as { days: number; rows: ActivityRow[] }}
      title={title}
    />
  ) : (
    <RefusalList
      ask={conversation?.ask}
      data={state.data as { rows: RefusalRow[] }}
      title={title}
    />
  );
}

function ActivityChart({
  data,
  title,
  ask,
}: {
  data: { days: number; rows: ActivityRow[] };
  title?: string;
  ask?: (text: string) => void;
}) {
  // Bots by the names people know them by: the trail counts them by id.
  const nameFor = useBotNames();
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <GalleryFrame title={title ?? "Bot activity"}>
        <p className="text-sm text-muted-foreground">
          No Bot has done anything in the last {data?.days ?? 7} days.
        </p>
      </GalleryFrame>
    );
  }

  const busiest = rows[0];
  const most = Math.max(...rows.map((row) => row.actions));

  return (
    <GalleryFrame
      action={
        ask && busiest ? (
          <Button
            onClick={() =>
              ask(
                `What has ${nameFor(busiest.bot) || busiest.bot} actually been doing? Look at the audit trail and summarise it.`,
              )
            }
            size="sm"
            variant="outline"
          >
            Ask about the busiest
          </Button>
        ) : undefined
      }
      caption={`Counted from OpenBot's audit trail, last ${data.days} days`}
      title={title ?? "Bot activity"}
    >
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li className="flex items-center gap-3" key={row.bot}>
            <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">
              {nameFor(row.bot)}
            </span>
            <span className="h-4 flex-1 overflow-hidden rounded bg-foreground/5">
              <span
                className="block h-full rounded"
                style={{
                  backgroundColor: seriesColour(index),
                  // Normalize to the busiest Bot so relative activity stays readable across ranges.
                  width: `${most === 0 ? 0 : Math.round((row.actions / most) * 100)}%`,
                }}
              />
            </span>
            <span className="w-12 shrink-0 text-right text-xs tabular-nums">
              {row.actions}
            </span>
          </li>
        ))}
      </ul>
    </GalleryFrame>
  );
}

function RefusalList({
  data,
  title,
  ask,
}: {
  data: { rows: RefusalRow[] };
  title?: string;
  ask?: (text: string) => void;
}) {
  const nameFor = useBotNames();
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <GalleryFrame title={title ?? "Recent refusals"}>
        <p className="text-sm text-muted-foreground">
          OpenBot hasn't refused anything.
        </p>
      </GalleryFrame>
    );
  }

  return (
    <GalleryFrame
      action={
        ask ? (
          <Button
            onClick={() =>
              ask(
                "Explain the most recent refusal in that list, and what would have to change for it to be allowed.",
              )
            }
            size="sm"
            variant="outline"
          >
            Explain the latest
          </Button>
        ) : undefined
      }
      caption="Read from OpenBot's audit trail"
      title={title ?? "Recent refusals"}
    >
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li className="text-sm" key={`${row.at}-${row.what}`}>
            <div className="flex items-baseline gap-2">
              {/* In words, as Activity says it: the trail stores `computer.action_refused`. */}
              <span className="font-medium">{auditEventWords(row.what)}</span>
              {row.bot ? (
                <span className="text-xs text-muted-foreground">
                  {nameFor(row.bot)}
                </span>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {new Date(row.at).toLocaleString()}
              </span>
            </div>
            {row.reason ? (
              <p className="text-xs text-muted-foreground">{row.reason}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    /*
     * NO `preview`, DELIBERATELY. This one reads the deployment through `callComponentFunction` as
     * soon as it mounts, and needs the Bot and conversation it was called in. Drawing it in Admin
     * would put a real read, attributed to whichever Bot happened to be active, behind a page that
     * only means to show what the component looks like. Admin draws it as unpreviewable instead.
     */
    name: "showActivityReport",
    title: TITLE,
    kind: "card",
    summary:
      "Shows what your Bots have been doing and what was refused, read from OpenBot's own records.",
    description:
      "Show what this deployment has actually been doing, read from its own records rather than from anything you know. Use for 'what have the Bots been up to' and 'what has been refused'. You choose the report and the period; the figures are read for you and you will not see them.",
    parameters: ActivityReportProps,
    Component: ActivityReportCard as GalleryComponent["Component"],
    confirmation:
      "The report is on screen for the person, filled with figures read from this deployment. You were not given the figures.",
    reads: (args) => {
      const report = typeof args.report === "string" ? args.report : undefined;
      const functionName = report
        ? keyedLookup(FUNCTION_FOR, report)
        : undefined;
      return functionName ? [functionName] : [];
    },
  },
];
