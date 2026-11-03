// biome-ignore-all lint/suspicious/noArrayIndexKey: a saved answer's rows never reorder, and labels can repeat
import { Pressable, Text, View } from "react-native";
import { card, colors, muted } from "./ui";

/**
 * A Bot's charts, figures, lists and choices, drawn on the phone.
 *
 * The PC draws these with the app's gallery. Before this the phone said "The Bot is using a tool."
 * for every one, so an answer given as a chart said nothing at all. These are plain Views, no chart
 * library, so the phone stays fast and light. They read the same arguments the PC's gallery does
 * (see server/src/components/headless.ts) and draw only what they recognise.
 */

type ToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
};
type Args = Record<string, unknown>;

const BAR = "#0B57D0";
const TONES: Record<string, string> = {
  positive: colors.success,
  caution: colors.warning,
  negative: colors.error,
};

function parse(call: unknown): { name: string; args: Args } | null {
  const fn = (call as ToolCall)?.function;
  if (!fn?.name) return null;
  try {
    const args = JSON.parse(fn.arguments || "{}");
    return args && typeof args === "object" ? { name: fn.name, args } : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const list = (value: unknown): Args[] =>
  Array.isArray(value)
    ? (value.filter((item) => item && typeof item === "object") as Args[])
    : [];
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function Title({ args }: { args: Args }) {
  return (
    <>
      <Text style={{ fontWeight: "600" }}>{text(args.title)}</Text>
      {text(args.caption) ? (
        <Text style={muted}>{text(args.caption)}</Text>
      ) : null}
    </>
  );
}

function Basis({ args }: { args: Args }) {
  if (args.basis !== "own-knowledge" && !text(args.asOf)) return null;
  return (
    <Text style={[muted, { fontSize: 11 }]}>
      {args.basis === "own-knowledge"
        ? "From the Bot's own knowledge, not checked. "
        : ""}
      {text(args.asOf) ? `As of ${text(args.asOf)}.` : ""}
    </Text>
  );
}

/** Bars for a bar chart, a pie (as shares of the whole) and progress against a target. */
function Bars({
  rows,
}: {
  rows: { label: string; value: number; of: number; note: string }[];
}) {
  return (
    <View style={{ gap: 8 }}>
      {rows.map((row, index) => (
        <View key={`${row.label}-${index}`} style={{ gap: 3 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text style={{ flexShrink: 1 }}>{row.label}</Text>
            <Text style={muted}>{row.note}</Text>
          </View>
          <View
            style={{ height: 8, borderRadius: 4, backgroundColor: "#e5e7eb" }}
          >
            <View
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: BAR,
                width: `${Math.max(0, Math.min(100, row.of > 0 ? (row.value / row.of) * 100 : 0))}%`,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function Chart({ name, args }: { name: string; args: Args }) {
  let rows: { label: string; value: number; of: number; note: string }[] = [];
  const points = list(args.points);
  if (name === "showBarChart") {
    const top = Math.max(...points.map((point) => num(point.value)), 0);
    rows = points.map((point) => ({
      label: text(point.label),
      value: num(point.value),
      of: top,
      note: text(point.value),
    }));
  } else if (name === "showPieChart") {
    const whole = points.reduce((sum, point) => sum + num(point.value), 0);
    rows = points.map((point) => ({
      label: text(point.label),
      value: num(point.value),
      of: whole,
      note: whole > 0 ? `${Math.round((num(point.value) / whole) * 100)}%` : "",
    }));
  } else if (name === "showProgress") {
    rows = points.map((point) => ({
      label: text(point.label),
      value: num(point.value),
      of: num(point.target),
      note: `${text(point.value)} of ${text(point.target)}`,
    }));
  } else {
    // Line and area charts: each series' latest value, against the highest anywhere.
    const labels = Array.isArray(args.labels) ? args.labels.map(text) : [];
    const series = list(args.series);
    const all = series.flatMap((line) =>
      Array.isArray(line.values) ? line.values.map(num) : [],
    );
    const top = Math.max(...all, 0);
    rows = series.map((line) => {
      const values = Array.isArray(line.values) ? line.values.map(num) : [];
      const last = values[values.length - 1] ?? 0;
      const first = values[0] ?? 0;
      return {
        label: `${text(line.name)}${labels.length ? ` (${labels[0]} to ${labels[labels.length - 1]})` : ""}`,
        value: last,
        of: top,
        note: values.length > 1 ? `${first} → ${last}` : String(last),
      };
    });
  }
  return (
    <View style={card}>
      <Title args={args} />
      <Bars rows={rows} />
      <Basis args={args} />
    </View>
  );
}

function Checklist({ args }: { args: Args }) {
  const items = list(args.items);
  const done = items.filter((item) => item.done === true).length;
  return (
    <View style={card}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontWeight: "600", flexShrink: 1 }}>
          {text(args.title)}
        </Text>
        <Text style={muted}>
          {done} of {items.length}
        </Text>
      </View>
      {items.map((item, index) => (
        <View
          key={`${text(item.text)}-${index}`}
          style={{ flexDirection: "row", gap: 8 }}
        >
          <Text style={{ color: item.done ? colors.success : colors.muted }}>
            {item.done ? "✓" : "○"}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={item.done ? muted : undefined}>{text(item.text)}</Text>
            {text(item.note) ? (
              <Text style={[muted, { fontSize: 12 }]}>{text(item.note)}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Metrics({ args }: { args: Args }) {
  return (
    <View style={card}>
      <Title args={args} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {list(args.metrics).map((metric, index) => (
          <View
            key={`${text(metric.label)}-${index}`}
            style={{ minWidth: "45%", flex: 1 }}
          >
            <Text style={[muted, { fontSize: 12 }]}>{text(metric.label)}</Text>
            <Text style={{ fontSize: 20, fontWeight: "600" }}>
              {text(metric.value)}
            </Text>
            {text(metric.change) ? (
              <Text
                style={{
                  fontSize: 12,
                  color: TONES[text(metric.changeTone)] ?? colors.muted,
                }}
              >
                {text(metric.change)}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function Fields({ args }: { args: Args }) {
  return (
    <View style={card}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text style={{ fontWeight: "600", flexShrink: 1 }}>
          {text(args.title)}
        </Text>
        {text(args.status) ? (
          <Text style={{ color: TONES[text(args.statusTone)] ?? colors.muted }}>
            {text(args.status)}
          </Text>
        ) : null}
      </View>
      {text(args.subtitle) ? (
        <Text style={muted}>{text(args.subtitle)}</Text>
      ) : null}
      {list(args.fields).map((field, index) => (
        <View
          key={`${text(field.label)}-${index}`}
          style={{ flexDirection: "row", gap: 8 }}
        >
          <Text style={[muted, { width: "38%" }]}>{text(field.label)}</Text>
          <Text style={{ flex: 1 }}>{text(field.value)}</Text>
        </View>
      ))}
    </View>
  );
}

/** A table as one small card per row, since eight columns don't fit a phone. */
function Table({ args }: { args: Args }) {
  const columns = Array.isArray(args.columns) ? args.columns.map(text) : [];
  const rows = list(args.rows).slice(0, 30);
  const total = list(args.rows).length;
  return (
    <View style={card}>
      <Title args={args} />
      {rows.map((row, index) => {
        const cells = Array.isArray(row.cells) ? row.cells.map(text) : [];
        return (
          <View
            key={index}
            style={{
              gap: 2,
              borderTopWidth: index ? 1 : 0,
              borderColor: colors.border,
              paddingTop: index ? 8 : 0,
            }}
          >
            <Text style={{ fontWeight: "600" }}>{cells[0]}</Text>
            {cells.slice(1).map((cell, at) => (
              <Text key={columns[at + 1] ?? at}>
                <Text style={muted}>{columns[at + 1]}: </Text>
                {cell}
              </Text>
            ))}
          </View>
        );
      })}
      {total > rows.length ? (
        <Text style={muted}>
          And {total - rows.length} more. Open it on your PC to see all.
        </Text>
      ) : null}
    </View>
  );
}

function Notice({ args }: { args: Args }) {
  return (
    <View
      style={[
        card,
        { borderLeftWidth: 4, borderLeftColor: TONES[text(args.tone)] ?? BAR },
      ]}
    >
      <Text style={{ fontWeight: "600" }}>{text(args.title)}</Text>
      <Text>{text(args.body)}</Text>
      {(Array.isArray(args.points) ? args.points.map(text) : []).map(
        (point, index) => (
          <Text key={index}>• {point}</Text>
        ),
      )}
    </View>
  );
}

function Quote({ args }: { args: Args }) {
  return (
    <View
      style={[card, { borderLeftWidth: 4, borderLeftColor: colors.border }]}
    >
      <Text style={{ fontStyle: "italic" }}>“{text(args.quote)}”</Text>
      <Text style={muted}>
        {text(args.attribution)}
        {text(args.context) ? `, ${text(args.context)}` : ""}
      </Text>
    </View>
  );
}

/**
 * A choice as buttons. Tapping one puts it in the message box to send, so the Bot gets the answer as
 * a reply; the PC's own card can still be answered there.
 */
function Choice({
  args,
  onPick,
}: {
  args: Args;
  onPick?: (words: string) => void;
}) {
  return (
    <View style={card}>
      <Text style={{ fontWeight: "600" }}>{text(args.title)}</Text>
      {text(args.summary) ? (
        <Text style={muted}>{text(args.summary)}</Text>
      ) : null}
      {list(args.options).map((option, index) => (
        <Pressable
          accessibilityRole="button"
          disabled={!onPick}
          key={`${text(option.id)}-${index}`}
          onPress={() => onPick?.(text(option.label))}
          style={{
            borderWidth: 1,
            borderColor: BAR,
            borderRadius: 20,
            paddingVertical: 10,
            paddingHorizontal: 14,
          }}
        >
          <Text style={{ color: BAR, fontWeight: "600" }}>
            {text(option.label)}
          </Text>
          {text(option.description) ? (
            <Text style={[muted, { fontSize: 12 }]}>
              {text(option.description)}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const ROLE_NAMES: Record<string, string> = {
  plan: "Planner",
  build: "Builder",
  check: "Checker",
};

function Subtask({ args }: { args: Args }) {
  return (
    <View style={card}>
      <Text style={{ fontWeight: "600" }}>
        {ROLE_NAMES[text(args.role)] ?? "Subtask"}
      </Text>
      <Text style={muted} numberOfLines={3}>
        {text(args.task)}
      </Text>
    </View>
  );
}

/** One tool call as a card, or null when it's a step the phone doesn't draw. */
export function AnswerCard({
  call,
  onPick,
}: {
  call: unknown;
  onPick?: (words: string) => void;
}) {
  const parsed = parse(call);
  if (!parsed) return null;
  const { name, args } = parsed;
  switch (name) {
    case "showBarChart":
    case "showPieChart":
    case "showLineChart":
    case "showAreaChart":
    case "showProgress":
      return <Chart args={args} name={name} />;
    case "showChecklist":
      return <Checklist args={args} />;
    case "showMetrics":
      return <Metrics args={args} />;
    case "showRecord":
      return <Fields args={args} />;
    case "showTable":
      return <Table args={args} />;
    case "showNotice":
      return <Notice args={args} />;
    case "showQuote":
      return <Quote args={args} />;
    case "askChoice":
      return <Choice args={args} onPick={onPick} />;
    case "run_subagent":
      return <Subtask args={args} />;
    default:
      return null;
  }
}

/** Whether any of a message's tool calls draws as a card. */
export function hasAnswerCards(calls: unknown[] | undefined): boolean {
  return (calls ?? []).some((call) => {
    const name = parse(call)?.name ?? "";
    return (
      /^show(?!ActivityReport)/.test(name) ||
      name === "askChoice" ||
      name === "run_subagent"
    );
  });
}
