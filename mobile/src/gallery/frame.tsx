/**
 * What every card a Bot draws is made of, as the web app's `gallery/frame.tsx`: a card with its title
 * and caption over a hairline, a badge in one of four tones, a figure that opens where it came from,
 * and the line under a chart that says where its figures are from.
 *
 * A Bot's arguments are read as it sent them, unchecked and maybe half written, so every reader here
 * takes `unknown` and gives back what it can use, or nothing.
 */
import type { ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";
import { useUniwind } from "uniwind";
import { cn } from "../components/cn";
import { Text } from "../components/text";
import { scheme } from "../scheme";
import { webLink } from "../web-link";
import { byPosition, list, record } from "./drawn";

export { list, record };

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
/** A figure that has arrived. While a chart streams, a point can be there before its number is. */
export const isValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Markdown a Bot wrote in a short value, as plain words: the marks go, a link keeps its name. */
export function plain(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : "";
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,;:!?])/g, "$1$2");
}

/** A figure as a person reads it: grouped thousands, two decimals at most. */
export function formatNumber(value: unknown): string {
  if (!isValue(value)) return "";
  if (Math.abs(value) >= 1000)
    return Math.round(value)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return String(Math.round(value * 100) / 100);
}

/** "14K", never "14,…": a shorter figure is still right, and one cut short is wrong. */
export function compactNumber(value: unknown): string {
  if (!isValue(value)) return "";
  const size = Math.abs(value);
  for (const [step, mark] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const) {
    if (size >= step) {
      const scaled = value / step;
      return `${Number(scaled.toPrecision(2))}${mark}`;
    }
  }
  return formatNumber(Number(value.toPrecision(3)));
}

/** Open a web address the Bot gave in the phone's browser. Anything but http(s) stays text. */
export function openLink(href: unknown) {
  const link = webLink(typeof href === "string" ? href : null);
  if (link) void Linking.openURL(link.href).catch(() => {});
}

export const isWebAddress = (href: unknown): href is string =>
  typeof href === "string" && webLink(href) !== null;

/**
 * The colors a chart's series take, from the scheme's chart tokens (no color of a chart's own), in an
 * order where neighbours stand apart on this theme's card.
 */
const ORDER = {
  light: ["chart-2", "chart-5", "chart-1", "chart-3", "chart-4"],
  dark: ["chart-1", "chart-3", "chart-2", "chart-5", "chart-4"],
} as const;

export function useChartColors() {
  const { theme } = useUniwind();
  const mode = theme === "dark" ? "dark" : "light";
  const colors = scheme[mode];
  return {
    series: (index: number) =>
      colors[ORDER[mode][index % ORDER[mode].length] as keyof typeof colors],
    border: colors.border,
    muted: colors.muted,
  };
}

export function GalleryFrame({
  title,
  caption,
  action,
  children,
}: {
  title?: string;
  /** One line under the title: why the Bot shows this. */
  caption?: string;
  /** Beside the title: a badge, a count. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="self-stretch overflow-hidden rounded-xl border border-border bg-surface">
      {title || action ? (
        <View className="flex-row items-start justify-between gap-3 border-border border-b px-4 py-3">
          <View className="min-w-0 flex-1">
            {title ? (
              <Text
                accessibilityRole="header"
                numberOfLines={2}
                className="font-medium text-sm leading-5"
              >
                {title}
              </Text>
            ) : null}
            {caption ? (
              <Text variant="caption" tone="muted" className="mt-0.5">
                {caption}
              </Text>
            ) : null}
          </View>
          {action ? <View className="shrink-0">{action}</View> : null}
        </View>
      ) : null}
      <View className="px-4 py-3">{children}</View>
    </View>
  );
}

/** How a value reads at a glance. A Bot picks one; a word this app doesn't know is neutral. */
export type Tone = "neutral" | "positive" | "caution" | "negative";

export function toneOf(value: unknown): Tone {
  return value === "positive" || value === "caution" || value === "negative"
    ? value
    : "neutral";
}

export function Badge({ tone, children }: { tone?: Tone; children: string }) {
  return (
    <View
      className={cn(
        "self-start rounded-md px-1.5 py-0.5",
        (!tone || tone === "neutral") && "bg-fill",
        tone === "positive" && "bg-success/10",
        tone === "caution" && "bg-warning/10",
        tone === "negative" && "bg-danger/10",
      )}
    >
      <Text
        variant="caption"
        tone={
          tone === "positive"
            ? "success"
            : tone === "caution"
              ? "warning"
              : tone === "negative"
                ? "danger"
                : "muted"
        }
        className="font-medium"
      >
        {children}
      </Text>
    </View>
  );
}

/**
 * A figure that opens where it came from, when the Bot gave a web address for it: in the phone's
 * browser, named by its label and value, since a bar read alone says neither.
 */
export function FigureLink({
  href,
  name,
  className,
  children,
}: {
  href: unknown;
  name: string;
  className?: string;
  children: ReactNode;
}) {
  if (!isWebAddress(href)) return <View className={className}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={name}
      accessibilityHint="Opens in your browser"
      onPress={() => openLink(href)}
      className={cn("rounded-md active:opacity-60", className)}
    >
      {children}
    </Pressable>
  );
}

/** The sources worth naming, once each; one that isn't a titled entry is skipped. */
function namedSources(sources: unknown): { title: string; url?: string }[] {
  const seen = new Set<string>();
  const named: { title: string; url?: string }[] = [];
  for (const entry of list(sources)) {
    const title = str(record(entry).title)?.trim();
    if (!title) continue;
    const url = isWebAddress(record(entry).url)
      ? (record(entry).url as string)
      : undefined;
    const key = `${title}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    named.push(url ? { title, url } : { title });
  }
  return named;
}

/** The line under a chart that says where its figures came from. Nothing when nobody said. */
export function Sources({ args }: { args: Record<string, unknown> }) {
  const named = namedSources(args.sources);
  const unchecked = args.basis === "own-knowledge";
  const asOf = str(args.asOf)?.trim() ?? "";
  if (!unchecked && named.length === 0 && !asOf) return null;
  return (
    <Text variant="caption" tone="muted" className="mt-3 leading-4">
      {unchecked ? (
        <Text variant="caption" tone="warning">
          From the Bot's own knowledge. Not checked against a source.
        </Text>
      ) : null}
      {named.length > 0 ? (
        <>
          {unchecked ? " · " : null}
          {"Sources: "}
          {byPosition(named).map(({ item, key }, index) => (
            <Text key={key} variant="caption" tone="muted">
              {index > 0 ? ", " : null}
              {item.url ? (
                <Text
                  accessibilityRole="link"
                  variant="caption"
                  tone="muted"
                  className="underline"
                  onPress={() => openLink(item.url)}
                >
                  {item.title}
                </Text>
              ) : (
                item.title
              )}
            </Text>
          ))}
        </>
      ) : null}
      {asOf
        ? `${unchecked || named.length > 0 ? " · " : ""}As of ${asOf}`
        : null}
    </Text>
  );
}

/** A card whose arguments are final and still can't be drawn: it says so, in place of waiting for good. */
export function FailedCard({ title }: { title: string }) {
  return (
    <GalleryFrame>
      <Text className="font-medium text-sm">
        Couldn't show the {title.toLowerCase()}.
      </Text>
      <Text tone="muted" className="mt-1 text-sm leading-5">
        The Bot sent data OpenBot couldn't read. Ask it to try again.
      </Text>
    </GalleryFrame>
  );
}

/** A line inside a card in place of what is still to come, or isn't there. */
export function Quiet({ children }: { children: string }) {
  return (
    <Text tone="muted" className="text-sm leading-5">
      {children}
    </Text>
  );
}
