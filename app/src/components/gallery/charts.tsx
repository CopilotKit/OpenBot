import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { GalleryFrame } from "./frame";
import { seriesColour } from "./palette";
import { byPosition } from "./positions";

const point = z.object({
  label: z
    .string()
    .describe("What this point is called, e.g. a month or a team"),
  value: z.number().describe("Its value"),
});

const source = z.object({
  title: z
    .string()
    .describe("The page, report or dataset, named the way a person would"),
  url: z.string().optional().describe("Its address, when it has one"),
});

/**
 * Where the figures came from, drawn under every chart.
 *
 * Required of the model, optional for the renderer. A chart is the most confident-looking thing a
 * Bot can produce, and a number recalled from training looks exactly like one read this morning, so
 * the Bot has to say which it is every time it draws one. Older conversations were drawn before the
 * field existed, which is why the card still renders without it.
 */
const provenance = {
  basis: z
    .enum(["read", "given", "own-knowledge"])
    .describe(
      "Where the figures come from. read: you read them with a tool in this conversation, and sources lists what you read. given: the person supplied them, in the conversation or a file. own-knowledge: you recalled them without looking them up; the chart then says they are unchecked. For figures that change over time, look them up before charting if you can",
    ),
  sources: z
    .array(source)
    .optional()
    .describe("What you read the figures from. Required when basis is read"),
  asOf: z
    .string()
    .optional()
    .describe(
      "When the figures are from, e.g. 'Q3 2026' or '24 Oct 2026'. Leave out for figures that do not date",
    ),
};

const common = {
  title: z.string().describe("A short title for the chart"),
  caption: z
    .string()
    .optional()
    .describe(
      "One line under the title saying what the reader should take from it",
    ),
  ...provenance,
};

type Provenance = Partial<{
  basis: "read" | "given" | "own-knowledge";
  sources: { title?: string; url?: string }[];
  asOf: string;
}>;

/** Only web addresses become links. Anything else the model wrote is shown as text. */
function isWebAddress(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * The sources worth naming, once each. The arguments are drawn as the model wrote them, unchecked,
 * so a source that is not a titled object is skipped instead of breaking the card.
 */
function namedSources(sources: unknown): { title: string; url?: string }[] {
  if (!Array.isArray(sources)) return [];
  const seen = new Set<string>();
  const named: { title: string; url?: string }[] = [];
  for (const entry of sources) {
    const title = typeof entry?.title === "string" ? entry.title.trim() : "";
    if (!title) continue;
    const url = isWebAddress(entry.url) ? entry.url : undefined;
    const key = `${title}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    named.push(url ? { title, url } : { title });
  }
  return named;
}

/** The line under a chart that says where its figures came from. Nothing when nobody said. */
function Sources({ basis, sources, asOf: when }: Provenance) {
  const named = namedSources(sources);
  const unchecked = basis === "own-knowledge";
  const asOf = typeof when === "string" ? when.trim() : "";
  if (!unchecked && named.length === 0 && !asOf) return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      {unchecked ? (
        <span className="text-amber-700 dark:text-amber-400">
          From the Bot's own knowledge. Not checked against a source.
        </span>
      ) : null}
      {named.length > 0 ? (
        <>
          {unchecked ? " · " : null}
          {"Sources: "}
          {byPosition(named).map(({ item: entry, key }, index) => (
            <span key={key}>
              {index > 0 ? ", " : null}
              {entry.url ? (
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={entry.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  {entry.title}
                </a>
              ) : (
                entry.title
              )}
            </span>
          ))}
        </>
      ) : null}
      {asOf ? (
        <>
          {unchecked || named.length > 0 ? " · " : null}
          {`As of ${asOf}`}
        </>
      ) : null}
    </p>
  );
}

/** Charts share a height so several in one answer do not stagger down the page. */
const HEIGHT = 180;

/**
 * A value that has arrived. While a chart streams, a point can be there before its number is, and
 * dividing by it drew a bar `NaN%` tall that collapsed and then popped in.
 */
function isValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value: unknown): string {
  if (!isValue(value)) return "";
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return String(Math.round(value * 100) / 100);
}

/** Nothing to draw is a sentence. An empty axis reads as a component that failed. */
function Empty() {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">
      There is no data to chart.
    </p>
  );
}

function Legend({ items }: { items: { label: string; colour: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {byPosition(items).map(({ item, key }) => (
        <li className="flex items-center gap-1.5 text-xs" key={key}>
          <span
            className="size-2 shrink-0 rounded-[3px]"
            style={{ background: item.colour }}
          />
          <span className="text-muted-foreground">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

export const BarChartProps = z.object({
  ...common,
  points: z
    .array(point)
    .describe("One bar per point, in the order they should appear"),
});

export function BarChartCard({
  title,
  caption,
  points: given,
  ...origin
}: Partial<z.infer<typeof BarChartProps>>) {
  const points = given ?? [];
  const max = Math.max(
    ...points.map((entry) => (isValue(entry.value) ? entry.value : 0)),
    0,
  );
  return (
    <GalleryFrame caption={caption} title={title}>
      {points.length === 0 ? (
        <Empty />
      ) : (
        // Columns stretch to full row height so percentage bar heights use the chart area.
        <div className="flex items-stretch gap-2" style={{ height: HEIGHT }}>
          {byPosition(points).map(({ item: entry, key }, index) => (
            <div
              className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              key={key}
            >
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatNumber(entry.value)}
              </span>
              {/* The bar lives in its own flexible box so the number above and the label below keep
                  their natural height and only the bar itself scales. */}
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t-md transition-[height] ${isValue(entry.value) ? "" : "bg-muted"}`}
                  style={{
                    // Normalize to the largest bar so similar values still show their differences.
                    // A bar whose number has not arrived holds the floor in a muted tone.
                    height:
                      max > 0 && isValue(entry.value)
                        ? `${Math.max((entry.value / max) * 100, 2)}%`
                        : "2%",
                    ...(isValue(entry.value)
                      ? { background: seriesColour(index) }
                      : {}),
                  }}
                />
              </div>
              <span className="w-full truncate text-center text-xs text-muted-foreground">
                {entry.label}
              </span>
            </div>
          ))}
        </div>
      )}
      <Sources {...origin} />
    </GalleryFrame>
  );
}

export const PieChartProps = z.object({
  ...common,
  points: z
    .array(point)
    .describe("One slice per point. Values are summed to make the whole"),
});

export function PieChartCard({
  title,
  caption,
  points: given,
  ...origin
}: Partial<z.infer<typeof PieChartProps>>) {
  const points = given ?? [];
  const size = 160;
  const stroke = 28;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = points.reduce(
    (sum, entry) => sum + (isValue(entry.value) ? entry.value : 0),
    0,
  );

  let travelled = 0;
  const slices = points.map((entry, index) => {
    const arc =
      total > 0 && isValue(entry.value)
        ? (entry.value / total) * circumference
        : 0;
    const slice = {
      ...entry,
      arc,
      offset: -travelled,
      colour: seriesColour(index),
    };
    travelled += arc;
    return slice;
  });

  return (
    <GalleryFrame caption={caption} title={title}>
      {points.length === 0 || total <= 0 ? (
        <Empty />
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          {/* One circle per slice: dasharray controls length and dashoffset controls start. */}
          <svg
            aria-hidden="true"
            className="shrink-0 -rotate-90"
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            width={size}
          >
            {byPosition(slices).map(({ item: slice, key }) => (
              <circle
                cx={size / 2}
                cy={size / 2}
                fill="none"
                key={key}
                r={radius}
                stroke={slice.colour}
                strokeDasharray={`${slice.arc} ${circumference - slice.arc}`}
                strokeDashoffset={slice.offset}
                strokeWidth={stroke}
              />
            ))}
          </svg>
          <ul className="min-w-0 flex-1 space-y-1.5">
            {byPosition(slices).map(({ item: slice, key }) => (
              <li className="flex items-center gap-2 text-sm" key={key}>
                <span
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ background: slice.colour }}
                />
                <span className="min-w-0 flex-1 truncate">{slice.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {isValue(slice.value)
                    ? `${Math.round((slice.value / total) * 100)}%`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Sources {...origin} />
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Line and area */

const seriesSchema = z.object({
  name: z.string().describe("What this line is called"),
  values: z
    .array(z.number())
    .describe("One value per label, in the same order"),
});

export const LineChartProps = z.object({
  ...common,
  labels: z.array(z.string()).describe("The x axis, e.g. months"),
  series: z.array(seriesSchema).describe("One line per series"),
});

type LineArgs = z.infer<typeof LineChartProps>;

/**
 * Line and area are the same geometry, so they are the same function.
 *
 * Sharing the scaler keeps line and area charts aligned.
 */
function Plot({
  labels,
  series,
  filled,
}: { labels: string[]; series: { name: string; values: number[] }[] } & {
  filled: boolean;
}) {
  const width = 520;
  const height = HEIGHT;
  const pad = { top: 8, right: 8, bottom: 18, left: 8 };

  const all = series.flatMap((line) => line.values);
  const max = Math.max(...all, 0);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const steps = Math.max(labels.length - 1, 1);

  const xAt = (index: number) =>
    pad.left + (index / steps) * (width - pad.left - pad.right);
  const yAt = (value: number) =>
    pad.top + (1 - (value - min) / span) * (height - pad.top - pad.bottom);

  return (
    <>
      <svg
        aria-hidden="true"
        className="w-full"
        height={height}
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        {/* Two guide lines give slope context without turning the chart into a grid. */}
        {[0.5, 1].map((fraction) => (
          <line
            className="stroke-border"
            key={fraction}
            strokeDasharray="3 3"
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + fraction * (height - pad.top - pad.bottom)}
            y2={pad.top + fraction * (height - pad.top - pad.bottom)}
          />
        ))}
        {byPosition(series).map(({ item: line, key }, index) => {
          const points = line.values.map(
            (value, i) => `${xAt(i)},${yAt(value)}`,
          );
          const colour = seriesColour(index);
          return (
            <g key={key}>
              {filled ? (
                <polygon
                  fill={colour}
                  fillOpacity={0.14}
                  points={`${xAt(0)},${height - pad.bottom} ${points.join(" ")} ${xAt(line.values.length - 1)},${height - pad.bottom}`}
                />
              ) : null}
              <polyline
                fill="none"
                points={points.join(" ")}
                stroke={colour}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
              />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between">
        {byPosition(labels).map(({ item: label, key }) => (
          <span className="truncate text-xs text-muted-foreground" key={key}>
            {label}
          </span>
        ))}
      </div>
      {series.length > 1 ? (
        <Legend
          items={series.map((line, index) => ({
            label: line.name,
            colour: seriesColour(index),
          }))}
        />
      ) : null}
    </>
  );
}

export function LineChartCard(args: Partial<LineArgs>) {
  const labels = args.labels ?? [];
  const series = (args.series ?? []).map((line) => ({
    name: line.name ?? "",
    values: line.values ?? [],
  }));
  return (
    <GalleryFrame caption={args.caption} title={args.title}>
      {series.length === 0 || labels.length === 0 ? (
        <Empty />
      ) : (
        <Plot filled={false} labels={labels} series={series} />
      )}
      <Sources {...args} />
    </GalleryFrame>
  );
}

export const AreaChartProps = LineChartProps;

export function AreaChartCard(args: Partial<LineArgs>) {
  const labels = args.labels ?? [];
  const series = (args.series ?? []).map((line) => ({
    name: line.name ?? "",
    values: line.values ?? [],
  }));
  return (
    <GalleryFrame caption={args.caption} title={args.title}>
      {series.length === 0 || labels.length === 0 ? (
        <Empty />
      ) : (
        <Plot filled labels={labels} series={series} />
      )}
      <Sources {...args} />
    </GalleryFrame>
  );
}

/* -------------------------------------------------------------------------- Progress */

export const ProgressChartProps = z.object({
  ...common,
  points: z
    .array(
      point.extend({
        target: z.number().describe("What the value is measured against"),
      }),
    )
    .describe("One row per thing being tracked"),
});

/**
 * Progress against a target, distinct from comparing independent bars.
 */
export function ProgressChartCard({
  title,
  caption,
  points: given,
  ...origin
}: Partial<z.infer<typeof ProgressChartProps>>) {
  const points = given ?? [];
  return (
    <GalleryFrame caption={caption} title={title}>
      {points.length === 0 ? (
        <Empty />
      ) : (
        <ul className="space-y-3">
          {byPosition(points).map(({ item: entry, key }, index) => {
            const share =
              isValue(entry.value) && isValue(entry.target) && entry.target > 0
                ? Math.min((entry.value / entry.target) * 100, 100)
                : 0;
            return (
              <li key={key}>
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="min-w-0 truncate">{entry.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(entry.value)} / {formatNumber(entry.target)}
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-foreground/5">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${share}%`,
                      background: seriesColour(index),
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Sources {...origin} />
    </GalleryFrame>
  );
}

/** Gallery component registration kept beside the chart implementations. */
export const GALLERY: GalleryComponent[] = [
  {
    name: "showBarChart",
    title: "Bar chart",
    kind: "chart",
    description:
      "Show values as a bar chart. Use when comparing a handful of named things, teams, months, categories. Not for a trend over time, which is showLineChart.",
    parameters: BarChartProps,
    Component: BarChartCard as GalleryComponent["Component"],
    preview: {
      basis: "given",
      title: "Revenue by team",
      caption: "Sales leads, and Engineering is closing the gap.",
      points: [
        { label: "Sales", value: 120 },
        { label: "Engineering", value: 80 },
        { label: "Support", value: 45 },
      ],
    },
    confirmation: "The bar chart is now on screen for the person.",
  },
  {
    name: "showPieChart",
    title: "Donut chart",
    kind: "chart",
    description:
      "Show how a whole is divided, as a donut with a legend. Use only when the parts sum to something meaningful, and prefer a bar chart above about six slices.",
    parameters: PieChartProps,
    Component: PieChartCard as GalleryComponent["Component"],
    preview: {
      basis: "given",
      title: "Where the month went",
      points: [
        { label: "Build", value: 48 },
        { label: "Support", value: 26 },
        { label: "Meetings", value: 26 },
      ],
    },
    confirmation: "The donut chart is now on screen for the person.",
  },
  {
    name: "showLineChart",
    title: "Line chart",
    kind: "chart",
    description:
      "Show one or more series over an ordered axis, usually time. Every series must have one value per label.",
    parameters: LineChartProps,
    Component: LineChartCard as GalleryComponent["Component"],
    preview: {
      basis: "given",
      title: "Signups",
      caption: "Six weeks, one release.",
      labels: ["W1", "W2", "W3", "W4", "W5", "W6"],
      series: [{ name: "Signups", values: [120, 180, 160, 240, 300, 420] }],
    },
    confirmation: "The line chart is now on screen for the person.",
  },
  {
    name: "showAreaChart",
    title: "Area chart",
    kind: "chart",
    description:
      "The same as showLineChart with the area under each line filled. Use for volume or accumulation rather than for a rate.",
    parameters: AreaChartProps,
    Component: AreaChartCard as GalleryComponent["Component"],
    preview: {
      basis: "given",
      title: "Storage used",
      caption: "Growing steadily since the migration.",
      labels: ["Jan", "Feb", "Mar", "Apr", "May"],
      series: [{ name: "TB", values: [12, 19, 26, 31, 44] }],
    },
    confirmation: "The area chart is now on screen for the person.",
  },
  {
    name: "showProgress",
    title: "Progress against target",
    kind: "chart",
    description:
      "Show values against their targets as progress bars. Use for 'are we there yet' questions, budget spent against budget, done against planned.",
    parameters: ProgressChartProps,
    Component: ProgressChartCard as GalleryComponent["Component"],
    preview: {
      basis: "given",
      title: "Migration to the new runtime",
      caption: "Two services left.",
      points: [
        { label: "Services moved", value: 18, target: 20 },
        { label: "Tests ported", value: 240, target: 240 },
      ],
    },
    confirmation: "The progress chart is now on screen for the person.",
  },
];
