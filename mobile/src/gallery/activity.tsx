/**
 * showActivityReport, as the web app's `gallery/activity.tsx` draws it: the Bot picks the report and
 * the period, and the figures are read from OpenBot as the Bot that drew it, once its arguments are
 * final. A read is kept for the card's tool call, so scrolling back to it doesn't read again.
 */
import { useContext, useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "../components/text";
import { dayAndTime } from "../when";
import { DrawnContext, type ReportRead } from "./context";
import { byPosition } from "./drawn";
import {
  FailedCard,
  GalleryFrame,
  isValue,
  list,
  Quiet,
  record,
  str,
  useChartColors,
} from "./frame";

const FUNCTION_FOR = new Map([
  ["activity", "botActivity"],
  ["refusals", "recentRefusals"],
]);

/** Reads already made, by tool call and what was asked. */
const READ = new Map<string, ReportRead>();

/** An audit event's type in words: `computer.action_refused` is "Computer action refused". */
function eventWords(type: string): string {
  const words = type.replace(/[._]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Refused";
}

export function ActivityReportCard({
  args,
  arriving,
  toolCallId,
  botId,
}: {
  args: Record<string, unknown>;
  arriving: boolean;
  toolCallId: string;
  botId: string | null;
}) {
  const { readReport, botName } = useContext(DrawnContext);
  const report = str(args.report);
  const name = report ? FUNCTION_FOR.get(report) : undefined;
  const days = isValue(args.days) ? args.days : undefined;
  const asked = `${toolCallId}|${name}|${days ?? ""}`;
  const [read, setRead] = useState<ReportRead | undefined>(READ.get(asked));
  const title = str(args.title);

  useEffect(() => {
    if (!name || arriving || !readReport) return;
    const kept = READ.get(asked);
    if (kept) {
      setRead(kept);
      return;
    }
    let current = true;
    void readReport(botId, name, days === undefined ? {} : { days }).then(
      (result) => {
        if (result.allowed) READ.set(asked, result);
        if (current) setRead(result);
      },
    );
    return () => {
      current = false;
    };
  }, [name, arriving, readReport, asked, botId, days]);

  if (!name) {
    if (!arriving) return <FailedCard title="Activity report" />;
    return (
      <GalleryFrame title="Report">
        <Quiet>Choosing a report…</Quiet>
      </GalleryFrame>
    );
  }
  if (!read)
    return (
      <GalleryFrame title={title ?? "Report"} caption="Reading from OpenBot">
        <Quiet>Reading…</Quiet>
      </GalleryFrame>
    );
  if (!read.allowed)
    return (
      <GalleryFrame title={title ?? "Report"}>
        <Text tone="danger" className="text-sm">
          Not shown
        </Text>
        <Text className="mt-1 text-sm leading-5">
          {read.reason ?? "Couldn't read that data."}
        </Text>
      </GalleryFrame>
    );
  const data = record(read.data);
  const nameOf = (id: unknown) =>
    typeof id === "string" ? (botName?.(id) ?? id) : "";
  if (report === "activity") {
    const rows = list(data.rows).map(record);
    const period = isValue(data.days) ? data.days : (days ?? 7);
    return (
      <ActivityBars
        title={title ?? "Bot activity"}
        period={period}
        rows={rows.map((row) => ({
          bot: nameOf(row.bot),
          actions: isValue(row.actions) ? row.actions : 0,
        }))}
      />
    );
  }
  const rows = list(data.rows).map(record);
  return (
    <GalleryFrame
      title={title ?? "Recent refusals"}
      caption={rows.length ? "Read from OpenBot's audit trail" : undefined}
    >
      {rows.length === 0 ? (
        <Quiet>OpenBot hasn't refused anything.</Quiet>
      ) : (
        <View className="gap-2.5">
          {byPosition(rows).map(({ item, key }) => (
            <View key={key}>
              <View className="flex-row items-baseline gap-2">
                <Text className="shrink font-medium text-sm">
                  {eventWords(str(item.what) ?? "")}
                </Text>
                {item.bot ? (
                  <Text variant="caption" tone="muted">
                    {nameOf(item.bot)}
                  </Text>
                ) : null}
                <Text variant="caption" tone="muted" className="ml-auto">
                  {dayAndTime(str(item.at))}
                </Text>
              </View>
              {str(item.reason) ? (
                <Text variant="caption" tone="muted">
                  {str(item.reason)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </GalleryFrame>
  );
}

function ActivityBars({
  title,
  period,
  rows,
}: {
  title: string;
  period: number;
  rows: { bot: string; actions: number }[];
}) {
  const colors = useChartColors();
  if (rows.length === 0)
    return (
      <GalleryFrame title={title}>
        <Quiet>{`No Bot has done anything in the last ${period} days.`}</Quiet>
      </GalleryFrame>
    );
  const most = Math.max(...rows.map((row) => row.actions));
  return (
    <GalleryFrame
      title={title}
      caption={`Counted from OpenBot's audit trail, last ${period} days`}
    >
      <View className="gap-2">
        {byPosition(rows).map(({ item, key }, index) => (
          <View
            key={key}
            accessible
            accessibilityLabel={`${item.bot}: ${item.actions}`}
            className="flex-row items-center gap-3"
          >
            <Text
              variant="caption"
              tone="muted"
              numberOfLines={1}
              className="w-24"
            >
              {item.bot}
            </Text>
            <View className="h-4 flex-1 overflow-hidden rounded bg-fill">
              <View
                className="h-full rounded"
                style={{
                  width: `${most === 0 ? 0 : Math.round((item.actions / most) * 100)}%`,
                  backgroundColor: colors.series(index),
                }}
              />
            </View>
            <Text variant="caption" className="w-10 text-right">
              {String(item.actions)}
            </Text>
          </View>
        ))}
      </View>
    </GalleryFrame>
  );
}
