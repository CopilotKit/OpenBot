/**
 * The cards a Bot draws to show one thing (showRecord, showMetrics, showChecklist, showNotice,
 * showQuote), as the web app's `gallery/cards.tsx` and `quote.tsx` draw them. Short values are drawn
 * as plain words; a notice's body and a quotation keep their Markdown.
 */
import { View } from "react-native";
import { BotMarkdown } from "../components/bot-markdown";
import { cn } from "../components/cn";
import { Icon } from "../components/icon";
import { Text } from "../components/text";
import { IconCheck } from "../icons";
import { byPosition } from "./drawn";
import {
  Badge,
  FigureLink,
  GalleryFrame,
  list,
  plain,
  Quiet,
  record,
  str,
  toneOf,
} from "./frame";

type CardArgs = { args: Record<string, unknown>; arriving: boolean };

export function RecordCard({ args, arriving }: CardArgs) {
  const fields = list(args.fields).map(record);
  const status = str(args.status);
  return (
    <GalleryFrame
      title={str(args.title)}
      caption={str(args.subtitle)}
      action={
        status ? <Badge tone={toneOf(args.statusTone)}>{status}</Badge> : null
      }
    >
      {fields.length === 0 ? (
        <Quiet>{arriving ? "Filling in the details…" : "No details."}</Quiet>
      ) : (
        <View className="gap-2">
          {byPosition(fields).map(({ item, key }) => (
            <View key={key} className="flex-row gap-4">
              <Text
                tone="muted"
                numberOfLines={2}
                className="w-28 text-sm leading-5"
              >
                {plain(item.label)}
              </Text>
              <Text selectable className="flex-1 text-sm leading-5">
                {plain(item.value)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </GalleryFrame>
  );
}

export function MetricsCard({ args, arriving }: CardArgs) {
  const metrics = list(args.metrics).map(record);
  return (
    <GalleryFrame title={str(args.title)} caption={str(args.caption)}>
      {metrics.length === 0 ? (
        <Quiet>{arriving ? "Adding the figures…" : "No figures."}</Quiet>
      ) : (
        <View className="flex-row flex-wrap gap-y-4">
          {byPosition(metrics).map(({ item, key }) => {
            const label = plain(item.label);
            const value = plain(item.value);
            const change = str(item.change);
            return (
              <FigureLink
                key={key}
                href={item.link}
                name={`${label}: ${value}`}
                className="w-1/2 pr-3"
              >
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {label}
                </Text>
                <Text className="mt-0.5 font-semibold text-xl">{value}</Text>
                {change ? (
                  <View className="mt-0.5">
                    <Badge tone={toneOf(item.changeTone)}>{change}</Badge>
                  </View>
                ) : null}
              </FigureLink>
            );
          })}
        </View>
      )}
    </GalleryFrame>
  );
}

/** A read-only checklist: done is the tick and a muted line, never a line through it. */
export function ChecklistCard({ args, arriving }: CardArgs) {
  const items = list(args.items).map(record);
  const done = items.filter((item) => item.done === true).length;
  return (
    <GalleryFrame
      title={str(args.title)}
      caption={str(args.caption)}
      action={
        <Badge
          tone={
            done === items.length && items.length > 0 ? "positive" : "neutral"
          }
        >
          {`${done} of ${items.length}`}
        </Badge>
      }
    >
      {items.length === 0 ? (
        <Quiet>{arriving ? "Listing the steps…" : "No steps."}</Quiet>
      ) : (
        <View className="gap-2">
          {byPosition(items).map(({ item, key }) => {
            const finished = item.done === true;
            const note = str(item.note);
            return (
              <View
                key={key}
                accessible
                accessibilityLabel={`${finished ? "Done" : "To do"}: ${plain(item.text)}${note ? `. ${plain(note)}` : ""}`}
                className="flex-row items-start gap-2.5"
              >
                <View
                  className={cn(
                    "mt-0.5 size-4 items-center justify-center rounded-[5px] border",
                    finished ? "border-success bg-success" : "border-border",
                  )}
                >
                  {finished ? (
                    <Icon
                      icon={IconCheck}
                      size={11}
                      strokeWidth={3}
                      color="accent-success-foreground"
                    />
                  ) : null}
                </View>
                <View className="flex-1">
                  <Text
                    tone={finished ? "muted" : "default"}
                    className="text-sm leading-5"
                  >
                    {plain(item.text)}
                  </Text>
                  {note ? (
                    <Text variant="caption" tone="muted">
                      {plain(note)}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </GalleryFrame>
  );
}

/** The words on a notice's badge. The tone is never its text; neutral has none. */
function noticeBadge(tone: unknown): string | null {
  switch (tone) {
    case "positive":
      return "Good news";
    case "caution":
      return "Heads up";
    case "negative":
      return "Problem";
    default:
      return null;
  }
}

export function NoticeCard({ args }: CardArgs) {
  const badge = noticeBadge(args.tone);
  const body = str(args.body);
  const points = list(args.points).filter(
    (point): point is string => typeof point === "string",
  );
  return (
    <GalleryFrame
      title={str(args.title)}
      action={badge ? <Badge tone={toneOf(args.tone)}>{badge}</Badge> : null}
    >
      {body ? <BotMarkdown text={body} /> : null}
      {points.length ? (
        <View className="mt-2 gap-1">
          {byPosition(points).map(({ item, key }) => (
            <View key={key} className="flex-row gap-2">
              <Text tone="muted" className="text-sm leading-5">
                ·
              </Text>
              <Text tone="muted" className="flex-1 text-sm leading-5">
                {plain(item)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </GalleryFrame>
  );
}

export function QuoteCard({ args, arriving }: CardArgs) {
  const quote = str(args.quote);
  const attribution = str(args.attribution);
  return (
    <GalleryFrame title="Quotation" caption={str(args.context)}>
      {quote ? (
        <View className="border-border border-l-2 pl-4">
          <BotMarkdown text={quote} />
          {attribution ? (
            <Text variant="caption" tone="muted" className="mt-2">
              {attribution}
            </Text>
          ) : null}
        </View>
      ) : (
        <Quiet>{arriving ? "…" : "There is nothing to quote."}</Quiet>
      )}
    </GalleryFrame>
  );
}
