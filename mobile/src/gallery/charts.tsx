/**
 * The charts a Bot draws (showBarChart, showPieChart, showLineChart, showAreaChart, showProgress), as
 * the web app's `gallery/charts.tsx` draws them: bars and progress as views, the donut and the lines
 * with react-native-svg. Each takes its arguments as the Bot sent them, maybe half written.
 */
import { useState } from "react";
import { View } from "react-native";
import Svg, { Circle, G, Line, Polygon, Polyline } from "react-native-svg";
import { cn } from "../components/cn";
import { Text } from "../components/text";
import { byPosition } from "./drawn";
import {
  compactNumber,
  FigureLink,
  formatNumber,
  GalleryFrame,
  isValue,
  list,
  record,
  Sources,
  str,
  useChartColors,
} from "./frame";

/** Charts share a height so several in one answer line up. */
const HEIGHT = 180;
/** Longer than this, a label under a standing bar can't be read: the bars lie down instead. */
const LONG_LABEL = 12;

type Point = { label: string; value?: number; link?: unknown };

function points(value: unknown): Point[] {
  return list(value).map((entry) => {
    const point = record(entry);
    return {
      label: str(point.label) ?? "",
      value: isValue(point.value) ? point.value : undefined,
      link: point.link,
    };
  });
}

/** Nothing to draw is a sentence, and while the figures are arriving it says they are. */
function Empty({ arriving }: { arriving: boolean }) {
  return (
    <View
      className="items-center justify-center"
      style={{ height: arriving ? HEIGHT : undefined }}
    >
      <Text tone="muted" className="py-6 text-sm">
        {arriving ? "Drawing the chart…" : "There is no data to chart."}
      </Text>
    </View>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <View className="mt-3 flex-row flex-wrap gap-x-4 gap-y-1">
      {byPosition(items).map(({ item, key }) => (
        <View key={key} className="flex-row items-center gap-1.5">
          <View
            className="size-2 rounded-[3px]"
            style={{ backgroundColor: item.color }}
          />
          <Text variant="caption" tone="muted">
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** What a chart says, for a screen reader: a picture of bars reads as nothing. */
function spoken(title: string | undefined, entries: string[]): string {
  return [title, ...entries].filter(Boolean).join(". ");
}

type ChartArgs = { args: Record<string, unknown>; arriving: boolean };

export function BarChartCard({ args, arriving }: ChartArgs) {
  const shown = points(args.points);
  const colors = useChartColors();
  const max = Math.max(...shown.map((point) => point.value ?? 0), 0);
  const long = shown.some((point) => point.label.trim().length > LONG_LABEL);
  // Many bars on a phone: every figure short, so they read as one scale.
  const short = shown.length > 5;
  const title = str(args.title);
  return (
    <GalleryFrame title={title} caption={str(args.caption)}>
      {shown.length === 0 ? (
        <Empty arriving={arriving} />
      ) : (
        <View
          accessible
          accessibilityLabel={spoken(
            title,
            shown.map(
              (point) => `${point.label}: ${formatNumber(point.value)}`,
            ),
          )}
        >
          {long ? (
            // Lying down, largest first, each named in full over its bar.
            <View className="gap-2.5">
              {byPosition(shown)
                .sort(
                  (a, b) =>
                    (b.item.value ?? Number.NEGATIVE_INFINITY) -
                    (a.item.value ?? Number.NEGATIVE_INFINITY),
                )
                .map(({ item, key }) => (
                  <FigureLink
                    key={key}
                    href={item.link}
                    name={`${item.label}: ${formatNumber(item.value)}`}
                    className="gap-1"
                  >
                    <Text numberOfLines={2} className="text-sm leading-5">
                      {item.label}
                    </Text>
                    <View className="flex-row items-center gap-1.5">
                      <View className="flex-1 flex-row items-center">
                        <View
                          className={cn(
                            "h-3 rounded-r-[4px]",
                            item.value === undefined && "bg-fill",
                          )}
                          style={{
                            width:
                              max > 0 && item.value !== undefined
                                ? `${Math.max((item.value / max) * 100, 1)}%`
                                : "2%",
                            ...(item.value !== undefined
                              ? { backgroundColor: colors.series(0) }
                              : {}),
                          }}
                        />
                      </View>
                      <Text variant="caption" tone="muted">
                        {formatNumber(item.value)}
                      </Text>
                    </View>
                  </FigureLink>
                ))}
            </View>
          ) : (
            <View
              className="flex-row items-stretch gap-2"
              style={{ height: HEIGHT }}
            >
              {byPosition(shown).map(({ item, key }, index) => (
                <FigureLink
                  key={key}
                  href={item.link}
                  name={`${item.label}: ${formatNumber(item.value)}`}
                  className="min-w-0 flex-1 items-center justify-end gap-1.5"
                >
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {short
                      ? compactNumber(item.value)
                      : formatNumber(item.value)}
                  </Text>
                  <View className="w-full flex-1 justify-end">
                    <View
                      className={cn(
                        "w-full rounded-t-md",
                        item.value === undefined && "bg-fill",
                      )}
                      style={{
                        height:
                          max > 0 && item.value !== undefined
                            ? `${Math.max((item.value / max) * 100, 2)}%`
                            : "2%",
                        ...(item.value !== undefined
                          ? { backgroundColor: colors.series(index) }
                          : {}),
                      }}
                    />
                  </View>
                  <Text
                    variant="caption"
                    tone="muted"
                    numberOfLines={1}
                    className="w-full text-center"
                  >
                    {item.label}
                  </Text>
                </FigureLink>
              ))}
            </View>
          )}
        </View>
      )}
      <Sources args={args} />
    </GalleryFrame>
  );
}

export function PieChartCard({ args, arriving }: ChartArgs) {
  const shown = points(args.points);
  const colors = useChartColors();
  const size = 140;
  const stroke = 24;
  const radius = (size - stroke) / 2;
  const around = 2 * Math.PI * radius;
  const total = shown.reduce((sum, point) => sum + (point.value ?? 0), 0);
  let travelled = 0;
  const slices = shown.map((point, index) => {
    const arc =
      total > 0 && point.value !== undefined
        ? (point.value / total) * around
        : 0;
    const slice = {
      ...point,
      arc,
      offset: -travelled,
      color: colors.series(index),
      share:
        total > 0 && point.value !== undefined
          ? `${Math.round((point.value / total) * 100)}%`
          : "",
    };
    travelled += arc;
    return slice;
  });
  const title = str(args.title);
  return (
    <GalleryFrame title={title} caption={str(args.caption)}>
      {shown.length === 0 || total <= 0 ? (
        <Empty arriving={arriving} />
      ) : (
        <View className="flex-row flex-wrap items-center gap-5">
          <View
            accessible
            accessibilityLabel={spoken(
              title,
              slices.map((slice) => `${slice.label}: ${slice.share}`),
            )}
          >
            <Svg width={size} height={size}>
              <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
                {byPosition(slices).map(({ item, key }) => (
                  <Circle
                    key={key}
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={item.color}
                    strokeWidth={stroke}
                    strokeDasharray={[item.arc, around - item.arc]}
                    strokeDashoffset={item.offset}
                  />
                ))}
              </G>
            </Svg>
          </View>
          <View className="min-w-32 flex-1 gap-1.5">
            {byPosition(slices).map(({ item, key }) => (
              <FigureLink
                key={key}
                href={item.link}
                name={`${item.label}: ${item.share}`}
                className="flex-row items-center gap-2"
              >
                <View
                  className="size-2.5 rounded-[3px]"
                  style={{ backgroundColor: item.color }}
                />
                <Text numberOfLines={1} className="flex-1 text-sm">
                  {item.label}
                </Text>
                <Text tone="muted" className="text-sm">
                  {item.share}
                </Text>
              </FigureLink>
            ))}
          </View>
        </View>
      )}
      <Sources args={args} />
    </GalleryFrame>
  );
}

/** The labels under a plot: all of them when they fit, else the first, the middle and the last. */
function axisLabels(labels: string[]): string[] {
  if (labels.length <= 6) return labels;
  return [
    labels[0] as string,
    labels[Math.floor((labels.length - 1) / 2)] as string,
    labels[labels.length - 1] as string,
  ];
}

/** Line and area are the same geometry, so they are the same card. */
function Plot({ args, arriving, filled }: ChartArgs & { filled: boolean }) {
  const colors = useChartColors();
  const [width, setWidth] = useState(0);
  const labels = list(args.labels).map((label) => str(label) ?? "");
  const series = list(args.series).map((entry) => ({
    name: str(record(entry).name) ?? "",
    values: list(record(entry).values).map((value) =>
      isValue(value) ? value : undefined,
    ),
  }));
  const title = str(args.title);
  const empty = series.length === 0 || labels.length === 0;
  const height = HEIGHT;
  const pad = { top: 8, right: 4, bottom: 8, left: 4 };
  const all = series.flatMap((line) =>
    line.values.filter((value): value is number => value !== undefined),
  );
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const steps = Math.max(labels.length - 1, 1);
  const xAt = (index: number) =>
    pad.left + (index / steps) * (width - pad.left - pad.right);
  const yAt = (value: number) =>
    pad.top + (1 - (value - min) / span) * (height - pad.top - pad.bottom);
  return (
    <GalleryFrame title={title} caption={str(args.caption)}>
      {empty ? (
        <Empty arriving={arriving} />
      ) : (
        <View
          accessible
          accessibilityLabel={spoken(
            title,
            series.map(
              (line) =>
                `${line.name}: ${line.values
                  .map(
                    (value, index) =>
                      `${labels[index] ?? ""} ${formatNumber(value)}`,
                  )
                  .join(", ")}`,
            ),
          )}
        >
          <View
            style={{ height }}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          >
            {width > 0 ? (
              <Svg width={width} height={height}>
                {/* Two guide lines give the slope context without a grid. */}
                {[0.5, 1].map((fraction) => {
                  const y =
                    pad.top + fraction * (height - pad.top - pad.bottom);
                  return (
                    <Line
                      key={fraction}
                      x1={pad.left}
                      x2={width - pad.right}
                      y1={y}
                      y2={y}
                      stroke={colors.border}
                      strokeDasharray={[3, 3]}
                    />
                  );
                })}
                {byPosition(series).map(({ item: line, key }, index) => {
                  const placed = line.values.flatMap((value, at) =>
                    value === undefined ? [] : [{ x: xAt(at), y: yAt(value) }],
                  );
                  if (placed.length === 0) return null;
                  const path = placed.map(({ x, y }) => `${x},${y}`).join(" ");
                  const color = colors.series(index);
                  const floor = height - pad.bottom;
                  return (
                    <G key={key}>
                      {filled ? (
                        <Polygon
                          points={`${placed[0]?.x},${floor} ${path} ${placed.at(-1)?.x},${floor}`}
                          fill={color}
                          fillOpacity={0.18}
                        />
                      ) : null}
                      <Polyline
                        points={path}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </G>
                  );
                })}
              </Svg>
            ) : null}
          </View>
          <View className="mt-1 flex-row justify-between gap-2">
            {byPosition(axisLabels(labels)).map(({ item, key }) => (
              <Text key={key} variant="caption" tone="muted" numberOfLines={1}>
                {item}
              </Text>
            ))}
          </View>
          {series.length > 1 ? (
            <Legend
              items={series.map((line, index) => ({
                label: line.name,
                color: colors.series(index),
              }))}
            />
          ) : null}
        </View>
      )}
      <Sources args={args} />
    </GalleryFrame>
  );
}

export function LineChartCard(props: ChartArgs) {
  return <Plot {...props} filled={false} />;
}

export function AreaChartCard(props: ChartArgs) {
  return <Plot {...props} filled />;
}

export function ProgressChartCard({ args, arriving }: ChartArgs) {
  const colors = useChartColors();
  const shown = list(args.points).map((entry) => {
    const point = record(entry);
    return {
      label: str(point.label) ?? "",
      value: isValue(point.value) ? point.value : undefined,
      target: isValue(point.target) ? point.target : undefined,
      link: point.link,
    };
  });
  return (
    <GalleryFrame title={str(args.title)} caption={str(args.caption)}>
      {shown.length === 0 ? (
        <Empty arriving={arriving} />
      ) : (
        <View className="gap-3">
          {byPosition(shown).map(({ item, key }, index) => {
            const share =
              item.value !== undefined &&
              item.target !== undefined &&
              item.target > 0
                ? Math.min((item.value / item.target) * 100, 100)
                : 0;
            const figures = `${formatNumber(item.value)} / ${formatNumber(item.target)}`;
            return (
              <FigureLink
                key={key}
                href={item.link}
                name={`${item.label}: ${formatNumber(item.value)} of ${formatNumber(item.target)}`}
              >
                <View
                  accessible
                  accessibilityLabel={`${item.label}: ${formatNumber(item.value)} of ${formatNumber(item.target)}`}
                >
                  <View className="flex-row items-baseline justify-between gap-4">
                    <Text numberOfLines={1} className="flex-1 text-sm">
                      {item.label}
                    </Text>
                    <Text tone="muted" className="text-sm">
                      {figures}
                    </Text>
                  </View>
                  <View className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-fill">
                    <View
                      className="h-full rounded-full"
                      style={{
                        width: `${share}%`,
                        backgroundColor: colors.series(index),
                      }}
                    />
                  </View>
                </View>
              </FigureLink>
            );
          })}
        </View>
      )}
      <Sources args={args} />
    </GalleryFrame>
  );
}
