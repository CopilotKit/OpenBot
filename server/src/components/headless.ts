import { z } from "zod";
import { NOT_SHOWN, NOT_SHOWN_TAIL } from "../../../shared/component-markers";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import type { HeadlessTool } from "../computer/headless-tools";
import type { ComponentStore } from "./store";

/**
 * Gallery components a headless turn can answer with, when no browser is attached to draw them.
 *
 * In a person's own turn a component is a frontend tool: the browser registers it, asks the server
 * whether this Bot may use it, and draws it. A routine or responsibility turn has no browser, so the
 * same call would go unanswered. Here the server answers it instead, under the SAME governance: the
 * published description, the per-Bot withholding and the data-function grants in `store.ts`, decided
 * again at call time. The call and its result reach the Intelligence thread as ordinary AG-UI tool
 * events, so opening the conversation later draws the real component with the renderer the app
 * registers under the same name. Nothing here draws anything.
 *
 * THE PARAMETER SCHEMAS ARE A MIRROR of the ones beside each React chart and card in
 * `app/src/components/gallery/`. The server image does not ship the app's sources, and a shared
 * module cannot import zod under the isolated install, so the schema is declared twice and
 * `server/tests/headless-components.test.ts` fails the moment the two stop producing the same JSON
 * Schema. Decisions (`askApproval`, `askChoice`, `askForm`) are deliberately absent: they suspend
 * the run for a person's answer, which a headless turn reaches through `ask_person`, not by drawing a
 * card nobody is looking at.
 */

const point = z.object({
  label: z
    .string()
    .describe("What this point is called, e.g. a month or a team"),
  value: z.number().describe("Its value"),
});

const common = {
  title: z.string().describe("A short title for the chart"),
  caption: z
    .string()
    .optional()
    .describe(
      "One line under the title saying what the reader should take from it",
    ),
};

const BarChartProps = z.object({
  ...common,
  points: z
    .array(point)
    .describe("One bar per point, in the order they should appear"),
});

const PieChartProps = z.object({
  ...common,
  points: z
    .array(point)
    .describe("One slice per point. Values are summed to make the whole"),
});

const seriesSchema = z.object({
  name: z.string().describe("What this line is called"),
  values: z
    .array(z.number())
    .describe("One value per label, in the same order"),
});

const LineChartProps = z.object({
  ...common,
  labels: z.array(z.string()).describe("The x axis, e.g. months"),
  series: z.array(seriesSchema).describe("One line per series"),
});

const ProgressChartProps = z.object({
  ...common,
  points: z
    .array(
      point.extend({
        target: z.number().describe("What the value is measured against"),
      }),
    )
    .describe("One row per thing being tracked"),
});

const tone = z
  .enum(["neutral", "positive", "caution", "negative"])
  .describe(
    "How this reads at a glance. Use negative and caution sparingly, for a refusal, a breach or a failure, not for anything merely notable",
  );

const RecordCardProps = z.object({
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

const MetricsCardProps = z.object({
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
      }),
    )
    .max(6)
    .describe("Up to six figures. More than that wanted a table"),
});

const ChecklistCardProps = z.object({
  title: z.string().describe("What this list is"),
  caption: z.string().optional(),
  items: z
    .array(
      z.object({
        text: z.string(),
        done: z.boolean().describe("Whether this one is already finished"),
        note: z
          .string()
          .optional()
          .describe("A short aside, e.g. who it is waiting on"),
      }),
    )
    .describe("The items, in the order they should be done"),
});

const NoticeCardProps = z.object({
  title: z.string().describe("The headline, in a few words"),
  body: z.string().describe("The explanation, in one or two sentences"),
  tone: tone.optional(),
  points: z
    .array(z.string())
    .optional()
    .describe("Supporting points, if there are any"),
});

const DataTableProps = z
  .object({
    title: z.string().trim().min(1).max(120),
    caption: z.string().max(500).optional(),
    columns: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(8)
      .describe("Unique column labels, in display order"),
    rows: z
      .array(
        z.object({
          cells: z
            .array(z.union([z.string().max(2000), z.number()]))
            .min(1)
            .max(8),
        }),
      )
      .max(100)
      .describe(
        "One cell per column. Use numbers for numeric sorting; strings for formatted values.",
      ),
  })
  .refine(
    (table) =>
      new Set(table.columns).size === table.columns.length &&
      table.rows.every((row) => row.cells.length === table.columns.length),
    "Column labels must be unique and every row must have one cell per column",
  );

const QuoteCardProps = z.object({
  quote: z
    .string()
    .describe("The quotation itself, without surrounding quote marks"),
  attribution: z
    .string()
    .describe(
      "Who said or wrote it, e.g. 'Grace Hopper' or 'the 2026 annual report'",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "One short line of context: where it is from, or why it matters here",
    ),
});

const ActivityReportProps = z.object({
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

/** Which server-side function each activity report reads. The same map `activity.tsx` holds. */
const ACTIVITY_FUNCTION_FOR: Record<string, string> = {
  activity: "botActivity",
  refusals: "recentRefusals",
};

export type HeadlessComponentSpec = {
  /** The tool name, the catalogue key, and the renderer's key in the app. */
  name: string;
  title: string;
  parameters: z.ZodType<Record<string, unknown>>;
  /** What the model is told once the call is recorded. Nobody is watching, so it says so. */
  confirmation: string;
  /** The data functions the component reads when drawn, decided before the call is recorded. */
  reads?: (args: Record<string, unknown>) => readonly string[];
};

const saved = (what: string) =>
  `The ${what} is saved in this conversation and is drawn when the person opens it.`;

/** Every display component a headless turn can record. Keyed by the same names the app registers. */
export const HEADLESS_COMPONENTS: readonly HeadlessComponentSpec[] = [
  {
    name: "showAreaChart",
    title: "Area chart",
    parameters: LineChartProps,
    confirmation: saved("area chart"),
  },
  {
    name: "showBarChart",
    title: "Bar chart",
    parameters: BarChartProps,
    confirmation: saved("bar chart"),
  },
  {
    name: "showLineChart",
    title: "Line chart",
    parameters: LineChartProps,
    confirmation: saved("line chart"),
  },
  {
    name: "showPieChart",
    title: "Donut chart",
    parameters: PieChartProps,
    confirmation: saved("donut chart"),
  },
  {
    name: "showProgress",
    title: "Progress against target",
    parameters: ProgressChartProps,
    confirmation: saved("progress chart"),
  },
  {
    name: "showRecord",
    title: "Record",
    parameters: RecordCardProps,
    confirmation: saved("record"),
  },
  {
    name: "showMetrics",
    title: "Headline figures",
    parameters: MetricsCardProps,
    confirmation:
      "The figures are saved in this conversation and are drawn when the person opens it.",
  },
  {
    name: "showChecklist",
    title: "Checklist",
    parameters: ChecklistCardProps,
    confirmation: saved("checklist"),
  },
  {
    name: "showNotice",
    title: "Notice",
    parameters: NoticeCardProps,
    confirmation: saved("notice"),
  },
  {
    name: "showTable",
    title: "Data table",
    parameters: DataTableProps as z.ZodType<Record<string, unknown>>,
    confirmation: saved("sortable table"),
  },
  {
    name: "showQuote",
    title: "Quotation",
    parameters: QuoteCardProps,
    confirmation: saved("quotation"),
  },
  {
    name: "showActivityReport",
    title: "Activity report",
    parameters: ActivityReportProps,
    confirmation:
      "The report is saved in this conversation. Its figures are read from this deployment when the person opens it; you were not given them.",
    reads: (args) => {
      const functionName =
        typeof args.report === "string"
          ? ACTIVITY_FUNCTION_FOR[args.report]
          : undefined;
      return functionName ? [functionName] : [];
    },
  },
];

/** The same sentence the browser answers a refused call with, so transcript and card agree. */
export function notShown(title: string, reason: string): string {
  return `${NOT_SHOWN}${title}. ${reason}${NOT_SHOWN_TAIL}`;
}

/**
 * The component tools for one headless turn, bound to the Bot and its owner outside the arguments.
 *
 * Offered exactly what the browser would offer this Bot: published, not withheld, with the
 * published description the model reads. A component this build mirrors but the Bot does not hold is
 * still registered, hidden, so a call the model makes anyway (a stale tool list, a remote agent with
 * its own) is answered with a governed refusal instead of being left unanswered.
 */
export async function createHeadlessComponentTools(options: {
  store: ComponentStore;
  botId: string;
  ownerUserId: string;
  initiator: AuditInitiator;
  auditStore?: AuditStore;
  specs?: readonly HeadlessComponentSpec[];
}): Promise<HeadlessTool[]> {
  const {
    store,
    botId,
    ownerUserId,
    initiator,
    auditStore,
    specs = HEADLESS_COMPONENTS,
  } = options;
  const held = new Map(
    (await store.listForAgent(botId)).map((entry) => [
      entry.name,
      entry.description,
    ]),
  );

  const refuse = async (
    spec: HeadlessComponentSpec,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (auditStore)
      await recordAuditEvent(auditStore, {
        eventType: extra.function
          ? "component.function_refused"
          : "component.refused",
        targetType: "component",
        targetId: spec.name,
        actorUserId: ownerUserId,
        initiator,
        payload: { bot: botId, reason, headless: true, ...extra },
      });
    return notShown(spec.title, reason);
  };

  return specs.map((spec) => {
    const description = held.get(spec.name);
    return {
      definition: {
        name: spec.name,
        description: description ?? spec.title,
        parameters: z.toJSONSchema(spec.parameters) as Record<string, unknown>,
      },
      ...(description === undefined ? { hidden: true } : {}),
      async execute(args) {
        const parsed = spec.parameters.safeParse(args);
        if (!parsed.success)
          return refuse(
            spec,
            `The ${spec.title.toLowerCase()} was called with data that does not match its declared shape: ${z.prettifyError(parsed.error)}.`,
            { invalid: true },
          );
        // Asked again at call time: the offered list is a snapshot from when the turn started.
        const decision = await store.decide(spec.name, botId);
        if (!decision.allowed) return refuse(spec, decision.reason);
        for (const functionName of spec.reads?.(parsed.data) ?? []) {
          if (await store.mayCall(spec.name, functionName)) continue;
          return refuse(
            spec,
            `${spec.name} has not been granted the function ${functionName}. An administrator grants each function to each component.`,
            { function: functionName },
          );
        }
        return spec.confirmation;
      },
    };
  });
}
