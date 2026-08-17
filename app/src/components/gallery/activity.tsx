import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { callComponentFunction } from "@/lib/components/queries";
import { useActiveBotId } from "@/lib/copilot/active-bot";
import { useConversation } from "@/lib/copilot/conversation";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { GalleryFrame } from "./frame";
import { seriesColour } from "./palette";

/**
 * Server-filled report component. The model chooses report arguments; data and permissions come
 * from the deployment.
 */

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

/** Which server-side function each report reads. Not the model's choice. */
const FUNCTION_FOR: Record<string, string> = {
  activity: "botActivity",
  refusals: "recentRefusals",
};

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

  const functionName = report ? FUNCTION_FOR[report] : undefined;

  useEffect(() => {
    // Nothing to read until the arguments have finished streaming in.
    if (!functionName) return;
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
                result.reason ?? result.error ?? "That data could not be read.",
            },
      );
    });

    return () => {
      current = false;
    };
  }, [functionName, days, botId]);

  if (!report) {
    return (
      <GalleryFrame title="Report">
        <p className="text-sm text-muted-foreground">Choosing a report…</p>
      </GalleryFrame>
    );
  }

  if (state.status === "reading") {
    return (
      <GalleryFrame
        caption="Reading from this deployment"
        title={title ?? "Report"}
      >
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
                `What has ${busiest.bot} actually been doing? Look at the audit trail and summarise it.`,
              )
            }
            size="sm"
            variant="outline"
          >
            Ask about the busiest
          </Button>
        ) : undefined
      }
      caption={`Counted from this deployment's audit trail, last ${data.days} days`}
      title={title ?? "Bot activity"}
    >
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li className="flex items-center gap-3" key={row.bot}>
            <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">
              {row.bot}
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
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <GalleryFrame title={title ?? "Recent refusals"}>
        <p className="text-sm text-muted-foreground">
          This deployment has refused nothing.
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
      caption="Read from this deployment's audit trail"
      title={title ?? "Recent refusals"}
    >
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li className="text-sm" key={`${row.at}-${row.what}`}>
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{row.what}</span>
              {row.bot ? (
                <span className="text-xs text-muted-foreground">{row.bot}</span>
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
    name: "showActivityReport",
    title: "Activity report",
    kind: "card",
    description:
      "Show what this deployment has actually been doing, read from its own records rather than from anything you know. Use for 'what have the Bots been up to' and 'what has been refused'. You choose the report and the period; the figures are read for you and you will not see them.",
    parameters: ActivityReportProps,
    Component: ActivityReportCard as GalleryComponent["Component"],
    confirmation:
      "The report is on screen for the person, filled with figures read from this deployment. You were not given the figures.",
    reads: (args) => {
      const report = typeof args.report === "string" ? args.report : undefined;
      const functionName = report ? FUNCTION_FOR[report] : undefined;
      return functionName ? [functionName] : [];
    },
  },
];
