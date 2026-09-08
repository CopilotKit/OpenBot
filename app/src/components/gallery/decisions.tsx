import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

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

const WorkspaceTransferProps = z.object({
  attachmentId: z.string().uuid().describe("The attached workspace file id"),
});

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
  approveLabel: z.string().optional().describe("Defaults to Approve"),
  rejectLabel: z.string().optional().describe("Defaults to Decline"),
  workspaceTransfer: WorkspaceTransferProps.optional().describe(
    "Use this only to approve uploading one exact received attachment to the ERP. Supply its attachmentId; the server verifies its filename, size and SHA-256 and creates the matching ERP reservation after approval. Never supply a transfer id, use this for a download, or use it for a Bot-to-Bot message.",
  ),
});

type ApprovalArgs = z.infer<typeof ApprovalCardProps>;

type TransferPreview = {
  attachmentId: string;
  transferId?: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  status: "READY" | "UPLOADED";
};

export function ApprovalCard(
  props: Waiting<ApprovalArgs> & { name?: string; agentId?: string },
) {
  const { args, status, respond } = props;
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<"approved" | "declined" | null>(null);
  const [transfer, setTransfer] = useState<TransferPreview | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  /*
   * Model-authored tool arguments are untrusted at render time. The schema is offered to the model,
   * but the runtime may still hand a renderer malformed optional fields. A bogus ERP reference must
   * not turn an otherwise ordinary decision into a button that can never be pressed.
   */
  const workspaceTransfer = useMemo(() => {
    const parsed = WorkspaceTransferProps.safeParse(args.workspaceTransfer);
    return parsed.success ? parsed.data : undefined;
  }, [args.workspaceTransfer]);
  const invalidWorkspaceTransfer =
    args.workspaceTransfer !== undefined && workspaceTransfer === undefined;

  useEffect(() => {
    if (status !== "executing" || !workspaceTransfer || !props.agentId) {
      return;
    }
    let current = true;
    void client<TransferPreview>(
      "/api/workspace-transfers/preview",
      "transfer",
      {
        method: "POST",
        body: { botId: props.agentId, ...workspaceTransfer },
        fallback: "The attached file could not be verified.",
      },
    )
      .then((result) => {
        if (current) setTransfer(result);
      })
      .catch((error) => {
        if (current)
          setTransferError(
            error instanceof Error
              ? error.message
              : "The attached file could not be verified.",
          );
      });
    return () => {
      current = false;
    };
  }, [props.agentId, status, workspaceTransfer]);

  const answer = async (decision: "approved" | "declined") => {
    if (!respond) return;
    setSending(decision);
    try {
      const uploaded =
        decision === "approved" && workspaceTransfer
          ? await client<TransferPreview>(
              "/api/workspace-transfers/approve",
              "transfer",
              {
                method: "POST",
                body: { botId: props.agentId, ...workspaceTransfer },
                fallback: "The approved file could not be uploaded.",
              },
            )
          : undefined;
      // The server action happens before the decision resumes the model, so the result is evidence
      // of the approved side effect rather than a model-authored promise to perform it later.
      await respond({
        decision,
        note: note.trim() || undefined,
        ...(uploaded
          ? { transfer: uploaded }
          : decision === "approved" && invalidWorkspaceTransfer
            ? {
                transfer: {
                  status: "NOT_ATTEMPTED",
                  reason:
                    "Invalid ERP transfer reference; no file was uploaded by this approval.",
                },
              }
            : {}),
      });
    } catch (error) {
      setTransferError(
        error instanceof Error
          ? error.message
          : "The approved file could not be uploaded.",
      );
      setSending(null);
    }
  };

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "Waiting for the assistant…"}>
        <p className="text-sm text-muted-foreground">Preparing the request…</p>
      </GalleryFrame>
    );
  }

  const decided =
    status === "complete" ? readDecision(props.result) : undefined;

  return (
    <GalleryFrame
      action={
        decided ? (
          <Badge tone={decided === "approved" ? "positive" : "negative"}>
            {decided === "approved" ? "Approved" : "Declined"}
          </Badge>
        ) : (
          <Badge tone="caution">Waiting on you</Badge>
        )
      }
      title={args.title}
    >
      <p className="text-sm">{args.summary}</p>

      {args.details?.length ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
          {args.details.map((detail) => (
            <div className="contents" key={detail.label}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {workspaceTransfer ? (
        <div className="mt-3 rounded-md border border-border p-3 text-sm">
          {transfer ? (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Verified file</dt>
              <dd className="break-words">{transfer.filename}</dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd>{transfer.sizeBytes.toLocaleString()} bytes</dd>
              <dt className="text-muted-foreground">SHA-256</dt>
              <dd className="break-all font-mono text-xs">{transfer.sha256}</dd>
              {transfer.transferId ? (
                <>
                  <dt className="text-muted-foreground">ERP transfer</dt>
                  <dd className="break-all font-mono text-xs">
                    {transfer.transferId}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : transferError ? (
            <p className="text-destructive">{transferError}</p>
          ) : (
            <p className="text-muted-foreground">
              Verifying the attached file…
            </p>
          )}
        </div>
      ) : invalidWorkspaceTransfer ? (
        <div className="mt-3 rounded-md border border-border p-3 text-sm">
          <p className="text-destructive">
            The invalid ERP transfer reference was ignored. This approval will
            not upload a file.
          </p>
        </div>
      ) : null}

      {decided ? null : (
        <div className="mt-4 space-y-2">
          <input
            aria-label="A reason, if you want to give one"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
            disabled={Boolean(sending)}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A reason, if you want to give one"
            value={note}
          />
          <div className="flex gap-2">
            <Button
              disabled={
                Boolean(sending) || Boolean(workspaceTransfer && !transfer)
              }
              onClick={() => void answer("approved")}
              size="sm"
            >
              {sending === "approved"
                ? "Sending…"
                : (args.approveLabel ?? "Approve")}
            </Button>
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("declined")}
              size="sm"
              variant="outline"
            >
              {sending === "declined"
                ? "Sending…"
                : (args.rejectLabel ?? "Decline")}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
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
  const [sending, setSending] = useState<string | null>(null);

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "Waiting for the assistant…"}>
        <p className="text-sm text-muted-foreground">Preparing the question…</p>
      </GalleryFrame>
    );
  }

  const chosen = status === "complete" ? readChoice(props.result) : undefined;

  return (
    <GalleryFrame
      action={
        chosen ? (
          <Badge tone="positive">Answered</Badge>
        ) : (
          <Badge tone="caution">Waiting on you</Badge>
        )
      }
      caption={args.summary}
      title={args.title}
    >
      <ul className="space-y-2">
        {(args.options ?? []).map((option) => {
          const picked = chosen === option.id;
          return (
            <li key={option.id}>
              <button
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  picked
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : chosen
                      ? "border-border opacity-50"
                      : "border-border hover:bg-foreground/5"
                }`}
                disabled={Boolean(chosen) || Boolean(sending)}
                onClick={async () => {
                  if (!respond) return;
                  setSending(option.id);
                  await respond({ choice: option.id, label: option.label });
                }}
                type="button"
              >
                <span className="font-medium">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </GalleryFrame>
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
): "approved" | "declined" | undefined {
  const value = readResult(result)?.decision;
  return value === "approved" || value === "declined" ? value : undefined;
}

function readChoice(result: string | undefined): string | undefined {
  const value = readResult(result)?.choice;
  return typeof value === "string" ? value : undefined;
}

/**
 * `kind: "decision"` is what makes these suspend the run: they are registered with
 * `useHumanInTheLoop` rather than as ordinary tools, and the person's answer IS the tool result, so
 * there is no confirmation line to give the model.
 */
export const GALLERY: GalleryComponent[] = [
  {
    name: "askApproval",
    title: "Approval",
    kind: "decision",
    description:
      "Ask the person to approve or decline something, and WAIT for their answer. Use before doing anything you cannot undo, spending money, sending a message, changing a record. You are given their decision and any reason they typed.",
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
    name: "askChoice",
    title: "Choice",
    kind: "decision",
    description:
      "Ask the person to pick one of several options, and WAIT for their answer. Use when you cannot sensibly guess which one they meant. You are given the id of the option they chose.",
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
