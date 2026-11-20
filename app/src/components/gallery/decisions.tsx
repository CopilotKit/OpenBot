import type { DecisionToolName } from "@openbot/shared/decision-tools";
import { useState } from "react";
import { z } from "zod";
import { DecisionCard, OTHER } from "@/components/decisions/decision-card";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { GalleryFrame } from "./frame";
import { GalleryMarkdown } from "./markdown";
import { byPosition } from "./positions";

/**
 * Human-in-the-loop gallery components. `respond` resolves the suspended Bot run, and completed
 * cards render the recorded answer rather than active controls.
 */

/** What the render props carry. Narrowed here so each component reads as its own small contract. */
type Waiting<T> =
  | {
      status: "inProgress";
      args: Partial<T>;
      respond: undefined;
      result: undefined;
    }
  | {
      status: "executing";
      args: T;
      respond: (result: unknown) => Promise<void>;
      result: undefined;
    }
  | { status: "complete"; args: T; respond: undefined; result: string };

export const ApprovalCardProps = z.object({
  title: z.string().describe("What is being approved, in a few words"),
  summary: z
    .string()
    .describe("What the person is agreeing to, in one or two sentences"),
  details: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe(
      "The facts they need in order to decide, e.g. amount, vendor, date",
    ),
  command: z
    .string()
    .optional()
    .describe(
      "When you are asking before running a command on your computer: that command, exactly as you will run it. It is shown on the card, and listed with their answer in your computer's Activity.",
    ),
  approveLabel: z.string().optional().describe("Defaults to Approve"),
  rejectLabel: z.string().optional().describe("Defaults to Decline"),
});

type ApprovalArgs = z.infer<typeof ApprovalCardProps>;

export function ApprovalCard(props: Waiting<ApprovalArgs> & { name?: string }) {
  const { args, status, respond } = props;
  const [sending, setSending] = useState(false);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "Waiting for the Bot…"}>
        <p className="text-sm text-muted-foreground">Preparing the request…</p>
      </GalleryFrame>
    );
  }

  const approve = args.approveLabel ?? "Approve";
  const decline = args.rejectLabel ?? "Decline";
  const decided =
    status === "complete" ? readDecision(props.result) : undefined;
  const command = args.command?.trim() || undefined;
  // The command once: a Bot that also lists it among the facts would show it twice.
  const details = (args.details ?? []).filter(
    (detail) => !command || detail.value?.trim() !== command,
  );

  return (
    <DecisionCard
      answer={
        decided
          ? decided.decision === "approved"
            ? { label: "Approved", choice: approve, tone: "positive" }
            : decided.decision === "declined"
              ? { label: "Declined", choice: decline, tone: "negative" }
              : { label: "Answered", note: decided.note, tone: "neutral" }
          : undefined
      }
      onSubmit={async (value, text) => {
        if (!respond) return;
        setSending(true);
        // Words instead of a yes or no go back as the answer itself; the Bot reads `note`.
        await respond(
          value === OTHER
            ? { decision: "other", note: text }
            : { decision: value },
        );
      }}
      options={[
        {
          value: "approved",
          label: approve,
          description: "The Bot goes ahead.",
        },
        {
          value: "declined",
          label: decline,
          description: "The Bot doesn't, and is told you declined.",
        },
      ]}
      other={{ placeholder: "Tell the Bot something else…" }}
      submitting={sending || !respond}
      title={args.title}
    >
      <GalleryMarkdown className="text-sm">{args.summary}</GalleryMarkdown>
      {command || details.length ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2 text-sm">
          {command ? (
            <div className="contents">
              <dt className="truncate text-muted-foreground">Command</dt>
              <dd className="min-w-0">
                <code className="break-all font-mono text-xs">{command}</code>
              </dd>
            </div>
          ) : null}
          {byPosition(details).map(({ item: detail, key }) => (
            <div className="contents" key={key}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">
                <GalleryMarkdown>{detail.value}</GalleryMarkdown>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </DecisionCard>
  );
}

export const ChoiceCardProps = z.object({
  title: z.string().describe("The question being asked"),
  summary: z
    .string()
    .optional()
    .describe("Any context the person needs to choose"),
  options: z
    .array(
      z.object({
        id: z
          .string()
          .describe("What comes back to you when this one is picked"),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .describe("The options, in the order they should be offered"),
});

type ChoiceArgs = z.infer<typeof ChoiceCardProps>;

export function ChoiceCard(props: Waiting<ChoiceArgs>) {
  const { args, status, respond } = props;
  const [sending, setSending] = useState(false);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "Waiting for the Bot…"}>
        <p className="text-sm text-muted-foreground">Preparing the question…</p>
      </GalleryFrame>
    );
  }

  const options = args.options ?? [];
  const chosen = status === "complete" ? readChoice(props.result) : undefined;
  const chosenLabel =
    chosen?.choice !== undefined
      ? (options.find((option) => option.id === chosen.choice)?.label ??
        chosen.choice)
      : undefined;

  return (
    <DecisionCard
      answer={
        chosen
          ? chosenLabel !== undefined
            ? { label: "Answered", choice: chosenLabel, tone: "positive" }
            : { label: "Answered", note: chosen.answer, tone: "positive" }
          : undefined
      }
      onSubmit={async (value, text) => {
        if (!respond) return;
        setSending(true);
        await respond(
          value === OTHER
            ? { answer: text }
            : {
                choice: value,
                label: options.find((option) => option.id === value)?.label,
              },
        );
      }}
      options={options.map((option) => ({
        value: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      }))}
      other={{ placeholder: "Answer something else…" }}
      submitting={sending || !respond}
      title={args.title}
    >
      {/* Drawn as the approval's summary is: a Bot writes it in markdown, which a caption shows raw. */}
      {args.summary ? (
        <GalleryMarkdown className="text-sm">{args.summary}</GalleryMarkdown>
      ) : null}
    </DecisionCard>
  );
}

/**
 * Read completed answers defensively from the runtime's serialized tool result.
 */
function readResult(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const parsed = JSON.parse(result);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readDecision(
  result: string | undefined,
): { decision: "approved" | "declined" | "other"; note?: string } | undefined {
  const read = readResult(result);
  const value = read?.decision;
  const note = typeof read?.note === "string" ? read.note : undefined;
  return value === "approved" || value === "declined" || value === "other"
    ? { decision: value, ...(note ? { note } : {}) }
    : undefined;
}

/** The option picked, or the words typed instead. */
function readChoice(
  result: string | undefined,
): { choice?: string; answer?: string } | undefined {
  const read = readResult(result);
  if (typeof read?.choice === "string") return { choice: read.choice };
  if (typeof read?.answer === "string") return { answer: read.answer };
  return undefined;
}

/**
 * `kind: "decision"` is what makes these suspend the run: they are registered as human-in-the-loop
 * tools (`useDecisionTool`) rather than as ordinary ones, and the person's answer IS the tool result, so
 * there is no confirmation line to give the model.
 */
export const GALLERY: GalleryComponent[] = [
  {
    name: "askApproval" satisfies DecisionToolName,
    title: "Approval",
    kind: "decision",
    summary:
      "Asks you to approve or decline something. The Bot waits for your answer.",
    description:
      "Ask the person to approve or decline something, and wait for their answer. You are given their decision: `approved`, `declined`, or `other` with `note`, what they wrote instead. Use it only before something you cannot undo that nothing else asks them about (your instructions say which kinds of action the person is already asked about), or for a decision only they can make. Do not use it to confirm a step they already asked you to take.",
    parameters: ApprovalCardProps,
    Component: ApprovalCard as GalleryComponent["Component"],
    preview: {
      // The whole interaction, because that is what this component is handed: it suspends a run,
      // so its arguments arrive wrapped in the state of the decision it is waiting on.
      status: "executing",
      args: {
        title: "Refund this order?",
        summary:
          "The customer was charged twice for the same order and the second charge has not settled.",
        details: [
          { label: "Amount", value: "$128.40" },
          { label: "Customer", value: "Northwind Traders" },
          { label: "Order", value: "2043" },
        ],
        approveLabel: "Refund",
      },
      respond: async () => {},
    },
  },
  {
    name: "askChoice" satisfies DecisionToolName,
    title: "Choice",
    kind: "decision",
    summary:
      "Asks you to pick one of several options. The Bot waits for your answer.",
    description:
      "Ask the person to pick one of several options, and wait for their answer. Use it only when the options lead to materially different work and nothing you can read settles it; otherwise pick the most reasonable one, say which, and carry on. You are given the id of the option they chose as `choice`, or `answer`, what they wrote instead.",
    parameters: ChoiceCardProps,
    Component: ChoiceCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "Which environment should this go to?",
        summary: "The build is green and nothing else is queued.",
        options: [
          {
            id: "staging",
            label: "Staging",
            description: "Safe, and reversible",
          },
          {
            id: "production",
            label: "Production",
            description: "Live customers",
          },
        ],
      },
      respond: async () => {},
    },
  },
];
