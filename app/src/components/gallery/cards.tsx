import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, FigureLink, GalleryFrame, type Tone } from "./frame";
import { GalleryMarkdown } from "./markdown";
import { byPosition } from "./positions";

const tone = z
  .enum(["neutral", "positive", "caution", "negative"])
  .describe(
    "How this reads at a glance. Use negative and caution sparingly, for a refusal, a breach or a failure, not for anything merely notable",
  );

export const RecordCardProps = z.object({
  title: z.string().describe("What this record is, e.g. a person or an order"),
  subtitle: z
    .string()
    .optional()
    .describe("One line of context under the title"),
  status: z.string().optional().describe("A short status word, e.g. Approved"),
  statusTone: tone.optional(),
  fields: z
    .array(
      z.object({
        label: z.string(),
        value: z.string().describe("Already formatted for a person to read"),
      }),
    )
    .describe("The fields, in the order they should be read"),
});

export function RecordCard({
  title,
  subtitle,
  status,
  statusTone,
  fields: given,
}: Partial<z.infer<typeof RecordCardProps>>) {
  const fields = given ?? [];
  return (
    <GalleryFrame
      action={
        status ? <Badge tone={statusTone as Tone}>{status}</Badge> : undefined
      }
      caption={subtitle}
      title={title}
    >
      <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
        {byPosition(fields).map(({ item: field, key }) => (
          // Keyed by position: a label is still being typed while the card draws.
          <div className="contents" key={key}>
            <dt className="truncate text-muted-foreground">{field.label}</dt>
            {/* Field values wrap because truncation can hide the reported data. */}
            <dd className="min-w-0 break-words">
              <GalleryMarkdown>{field.value}</GalleryMarkdown>
            </dd>
          </div>
        ))}
      </dl>
    </GalleryFrame>
  );
}

export const MetricsCardProps = z.object({
  title: z.string().describe("What these figures are about"),
  caption: z.string().optional(),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        value: z
          .string()
          .describe("Already formatted, including any unit or currency"),
        change: z
          .string()
          .optional()
          .describe("The movement, e.g. '+12% on last month'"),
        changeTone: tone.optional(),
        link: z
          .string()
          .optional()
          .describe(
            "A web address this opens: the record, search or message it came from. Only one you actually have; never make one up",
          ),
      }),
    )
    .max(6)
    .describe("Up to six figures. More than that wanted a table"),
});

export function MetricsCard({
  title,
  caption,
  metrics: given,
}: Partial<z.infer<typeof MetricsCardProps>>) {
  const metrics = given ?? [];
  return (
    <GalleryFrame caption={caption} title={title}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {byPosition(metrics).map(({ item: metric, key }) => (
          <FigureLink
            href={metric.link}
            key={key}
            name={`${metric.label}: ${metric.value}`}
          >
            <p className="truncate text-xs text-muted-foreground">
              {metric.label}
            </p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums">
              {metric.value}
            </p>
            {metric.change ? (
              <p className="mt-0.5">
                <Badge tone={metric.changeTone as Tone}>{metric.change}</Badge>
              </p>
            ) : null}
          </FigureLink>
        ))}
      </div>
    </GalleryFrame>
  );
}

export const ChecklistCardProps = z.object({
  title: z.string().describe("What this list is"),
  caption: z.string().optional(),
  items: z
    .array(
      z.object({
        text: z.string(),
        done: z.boolean().describe("Whether this task is already finished"),
        note: z
          .string()
          .optional()
          .describe("A short aside, e.g. who it is waiting on"),
      }),
    )
    .describe("The tasks, in the order they should be done"),
});

/**
 * A read-only checklist. Interactive decisions use the approval components where answers go back
 * to the Bot.
 */
export function ChecklistCard({
  title,
  caption,
  items: given,
}: Partial<z.infer<typeof ChecklistCardProps>>) {
  const items = given ?? [];
  const done = items.filter((item) => item.done).length;
  return (
    <GalleryFrame
      action={
        <Badge
          tone={
            done === items.length && items.length > 0 ? "positive" : "neutral"
          }
        >
          {done} of {items.length}
        </Badge>
      }
      caption={caption}
      title={title}
    >
      <ul className="space-y-2">
        {byPosition(items).map(({ item, key }) => (
          <li className="flex items-start gap-2.5 text-sm" key={key}>
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px] ${
                item.done
                  ? "border-transparent bg-emerald-500 text-white"
                  : "border-border"
              }`}
            >
              {item.done ? "✓" : ""}
            </span>
            {/*
             * Done is the tick and a muted line, never a line through it. A strike reads as deleted,
             * and a list whose every item is finished was drawn as an answer crossed out.
             */}
            <div className="min-w-0">
              <div className={item.done ? "text-muted-foreground" : ""}>
                <span className="sr-only">
                  {item.done ? "Done: " : "To do: "}
                </span>
                <GalleryMarkdown>{item.text}</GalleryMarkdown>
              </div>
              {/* Inline code in a reply is a fixed text-sm, which stood taller than this smaller line. */}
              <GalleryMarkdown className="text-xs text-muted-foreground [&_code]:text-xs">
                {item.note}
              </GalleryMarkdown>
            </div>
          </li>
        ))}
      </ul>
    </GalleryFrame>
  );
}

export const NoticeCardProps = z.object({
  title: z.string().describe("The headline, in a few words"),
  body: z.string().describe("The explanation, in one or two sentences"),
  tone: tone.optional(),
  points: z
    .array(z.string())
    .optional()
    .describe("Supporting points, if there are any"),
});

/**
 * The words on a notice's badge. The tone picks the badge's colour and is never its text: a notice
 * drawn with `tone: "positive"` read "positive", a styling value shown to the person. Neutral has no
 * badge, and so has a tone still arriving while the card draws.
 */
function noticeBadge(tone: string | undefined): string | null {
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

export function NoticeCard({
  title,
  body,
  tone: noticeTone,
  points,
}: Partial<z.infer<typeof NoticeCardProps>>) {
  const badge = noticeBadge(noticeTone);
  return (
    <GalleryFrame
      action={badge ? <Badge tone={noticeTone}>{badge}</Badge> : undefined}
      title={title}
    >
      <GalleryMarkdown className="text-sm">{body}</GalleryMarkdown>
      {points?.length ? (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {byPosition(points).map(({ item: entry, key }) => (
            // A point that is itself a list keeps only its own markers and indent, not a dot beside it.
            <li
              className="flex gap-2 [&:has(>div>:is(ol,ul):first-child)>span]:hidden [&>div>:is(ol,ul)]:pl-0"
              key={key}
            >
              <span aria-hidden="true">·</span>
              <GalleryMarkdown className="min-w-0">{entry}</GalleryMarkdown>
            </li>
          ))}
        </ul>
      ) : null}
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "showRecord",
    title: "Record",
    kind: "card",
    summary:
      "Shows one thing and its details, such as an order, a person or a ticket.",
    description:
      "Show one thing and its fields, an order, a person, a ticket. Use when there are several fields worth reading side by side; a fact or two about it belong in a Markdown reply.",
    parameters: RecordCardProps,
    Component: RecordCard as GalleryComponent["Component"],
    preview: {
      title: "Invoice 2043",
      subtitle: "Northwind Traders",
      status: "Approved",
      fields: [
        { label: "Amount", value: "$4,280.00" },
        { label: "Raised", value: "12 March" },
        { label: "Owner", value: "Priya Raman" },
      ],
    },
    confirmation: "The record is now on screen for the person.",
  },
  {
    name: "showMetrics",
    title: "Headline figures",
    kind: "card",
    summary: "Shows up to six headline figures and how each one has changed.",
    description:
      "Show up to six headline figures, each with an optional movement. Use for figures somebody reads at a glance, not for a written summary. A figure may link to the page it came from, such as the record or the report, when you have that address; never make one up.",
    parameters: MetricsCardProps,
    Component: MetricsCard as GalleryComponent["Component"],
    preview: {
      title: "This month",
      metrics: [
        {
          label: "Revenue",
          value: "$412k",
          change: "+12% on last month",
          changeTone: "positive",
        },
        { label: "Open deals", value: "38" },
        {
          label: "Churn",
          value: "1.4%",
          change: "+0.3pt",
          changeTone: "caution",
        },
      ],
    },
    confirmation: "The figures are now on screen for the person.",
  },
  {
    name: "showChecklist",
    title: "Checklist",
    kind: "card",
    summary:
      "Shows the steps of a piece of work and which ones are done, such as a release plan.",
    description:
      "Show the tasks or steps of a piece of work and which are finished, such as a release plan or an onboarding list. Only for work somebody ticks off. Not for presenting information: findings, options, recommendations and ordinary lists of points belong in a Markdown reply. The person cannot tick these here, so do not use it to ask for anything.",
    parameters: ChecklistCardProps,
    Component: ChecklistCard as GalleryComponent["Component"],
    preview: {
      title: "Before the release",
      items: [
        { text: "Migrations applied", done: true },
        { text: "Changelog written", done: true },
        { text: "Load test", done: false, note: "Waiting on staging" },
      ],
    },
    confirmation: "The checklist is now on screen for the person.",
  },
  {
    name: "showNotice",
    title: "Notice",
    kind: "card",
    summary:
      "Shows a headline with a short explanation and a few supporting points.",
    description:
      "Show a distinct actionable alert needing the person's attention, such as a failed scheduled task requiring intervention or a new issue blocking their work. Also use when the person explicitly asks for a notice card. Answer ordinary questions, explanations, summaries, recommendations and short lists directly in Markdown, including important emails or deadlines. Importance, a caveat or several paragraphs alone does not justify a notice. Do not use this to wrap or repeat a routine answer. Body and supporting points support Markdown.",
    parameters: NoticeCardProps,
    Component: NoticeCard as GalleryComponent["Component"],
    preview: {
      title: "Certificate expires in 30 days",
      body: "The checkout certificate has an owner now, and this is the first of the new alerts.",
      tone: "caution",
      points: ["Owner: Platform", "Renews automatically once approved"],
    },
    confirmation: "The notice is now on screen for the person.",
  },
];
