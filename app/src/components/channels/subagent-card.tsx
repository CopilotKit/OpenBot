import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import {
  isSubagentRole,
  readSubagentResult,
  SUBAGENT_ROLE_NAMES,
} from "@openbot/shared/subagent";
import { readToolName } from "@openbot/shared/tool-name";
import {
  IconChevronDown,
  IconChevronUp,
  IconHandStop,
  IconSubtask,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Badge, GalleryFrame, type Tone } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import { ItemMedia } from "@/components/ui/item";
import { markdownComponents, markdownPlugins } from "@/lib/markdown";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { subagentStepsQueryOptions } from "@/lib/subagents/queries";
import { toVisibleChatItems, type VisibleChatItem } from "./chat-messages";
import { StepRow, stepDetails } from "./tool-activity";
import { ToolLine } from "./tool-line";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/**
 * A piece of work a Bot gave to a subagent, drawn in the conversation as it happens.
 *
 * A subagent is the same Bot run again on one part of the work, in a thread of its own, so its steps
 * are not in this conversation at all. This card is where the person sees them: the task it was
 * given, each step as it takes it (read from its own thread while it works), then its answer with the
 * steps folded away behind a disclosure. An action that needed the person's yes comes back as a
 * plain notice, and the Bot asks for it in the conversation below.
 *
 * Called a subtask on screen, because that is what the person is looking at: part of what they
 * asked for, being done on its own. "Agent" is a word OpenBot keeps for software somebody brings.
 */
export function SubagentCard({
  toolCallId,
  task,
  role,
  result,
  running,
}: {
  toolCallId: string;
  task: string | undefined;
  /** Planner, builder or checker, when the Bot gave it one. */
  role?: string | undefined;
  /** The call's result. Absent while it runs, or after a turn that stopped before it answered. */
  result: string | undefined;
  /** The turn is still working on this call. */
  running: boolean;
}) {
  const answer = result === undefined ? undefined : asText(result);
  const label = isSubagentRole(role) ? SUBAGENT_ROLE_NAMES[role] : "Subtask";
  if (answer?.startsWith(REFUSAL_MARKER))
    return (
      <ToolLine detail={task} label={label} refused>
        <p className="text-sm">{answer.slice(REFUSAL_MARKER.length).trim()}</p>
      </ToolLine>
    );
  return (
    <SubtaskFrame
      label={label}
      result={answer}
      running={running && result === undefined}
      task={task}
      toolCallId={toolCallId}
    />
  );
}

function SubtaskFrame({
  toolCallId,
  label,
  task,
  result,
  running,
}: {
  toolCallId: string;
  label: string;
  task: string | undefined;
  result: string | undefined;
  running: boolean;
}) {
  const chat = useCopilotChatConfiguration();
  const settled = result === undefined ? null : readSubagentResult(result);
  const thread = useQuery(
    subagentStepsQueryOptions({
      toolCallId,
      parentThreadId: chat?.threadId,
      threadId: settled?.threadId,
      agentId: chat?.agentId ?? "default",
      live: running,
    }),
  );
  const steps = (thread.data ? toVisibleChatItems(thread.data.messages) : [])
    .filter((item): item is ToolItem => item.kind === "tool")
    .map(stepDetails);
  const count = Math.max(steps.length, settled?.steps ?? 0);

  const status: { tone: Tone; words: string } = running
    ? { tone: "neutral", words: "Working" }
    : !settled
      ? { tone: "neutral", words: "Not completed" }
      : "answer" in settled
        ? { tone: "positive", words: "Done" }
        : "handedBack" in settled
          ? { tone: "caution", words: "Needs your approval" }
          : { tone: "caution", words: "Didn't finish" };

  const stepList = (
    <ol className="space-y-2 text-xs">
      {steps.map((step) => (
        <StepRow active={running} key={step.id} step={step} />
      ))}
    </ol>
  );

  const progress =
    count > 0
      ? `${count} ${count === 1 ? "step" : "steps"}${running ? " so far" : ""}`
      : running
        ? "Starting"
        : undefined;

  return (
    <GalleryFrame>
      <div className="flex items-start gap-3">
        <ItemMedia variant="icon">
          <IconSubtask />
        </ItemMedia>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-medium">
              {label}
              {progress ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {progress}
                </span>
              ) : null}
            </p>
            <span className={`shrink-0 ${running ? "tool-line-running" : ""}`}>
              <Badge tone={status.tone}>{status.words}</Badge>
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
            {task}
          </p>
        </div>
      </div>

      {running && steps.length > 0 ? (
        <div className="mt-3 border-t pt-3">{stepList}</div>
      ) : null}

      {settled && "answer" in settled ? (
        <div className="mt-3 border-t pt-3">
          <Clamped>
            <Streamdown
              className="text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium"
              components={markdownComponents}
              plugins={markdownPlugins}
            >
              {settled.answer}
            </Streamdown>
          </Clamped>
        </div>
      ) : null}

      {settled && "handedBack" in settled ? (
        <HandedBack {...settled.handedBack} />
      ) : null}

      {settled && "error" in settled ? (
        <p className="mt-3 border-t pt-3 text-sm text-amber-600 dark:text-amber-500">
          {settled.error}
        </p>
      ) : null}

      {!running && steps.length > 0 ? (
        <details className="tool-line mt-3 border-t pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="tool-line-chevron shrink-0 transition-transform"
            >
              ▸
            </span>
            {steps.length === 1
              ? "Show the step"
              : `Show ${steps.length} steps`}
          </summary>
          <div className="mt-2 pl-5">{stepList}</div>
        </details>
      ) : null}
    </GalleryFrame>
  );
}

/**
 * The action the subagent stopped before, said plainly. Nothing was done and nobody was asked; the
 * Bot asks in this conversation, where the person answers it as any other approval.
 */
function HandedBack({ tool, args }: { tool: string; args: unknown }) {
  const { label, detail } = readToolName(tool);
  const inputs =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [];
  return (
    <section
      aria-label="Needs your approval"
      className="mt-3 space-y-2 rounded-lg border p-3 text-sm"
    >
      <p className="flex items-start gap-2 font-medium">
        <IconHandStop
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0">
          {label}
          {detail ? ` on ${detail}` : ""}
        </span>
      </p>
      <p className="text-muted-foreground">
        It stopped before this step, so you're asked about it in this
        conversation instead.
      </p>
      {inputs.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {inputs.map(([key, value]) => (
            <div className="contents" key={key}>
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** An answer held to a few lines, with a control for the rest when there is more. */
function Clamped({ children }: { children: React.ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () =>
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        className={
          open
            ? undefined
            : overflows
              ? "max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
              : "max-h-28 overflow-hidden"
        }
        ref={body}
      >
        {children}
      </div>
      {overflows || open ? (
        <Button
          aria-expanded={open}
          className="mt-1 -ml-2 text-muted-foreground"
          onClick={() => setOpen((was) => !was)}
          size="xs"
          variant="ghost"
        >
          {open ? <IconChevronUp /> : <IconChevronDown />}
          {open ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </>
  );
}
