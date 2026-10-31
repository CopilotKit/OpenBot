import { IconCircleCheck, IconClock, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 */
export function ToolLine({
  icon,
  label,
  detail,
  running,
  refused,
  failed,
  declined,
  notYet,
  waiting,
  children,
}: {
  /** Drawn after the label, small and muted. A group of steps puts its kinds here. */
  icon?: ReactNode;
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** The person said no on its card, so it was not done. Their decision, not a failure. */
  declined?: boolean;
  /**
   * Nothing was done yet, for an ordinary reason: a computer still starting turned the call away
   * before it reached anything. Muted like a success, because nothing went wrong, and labelled so it
   * does not read as one.
   */
  notYet?: boolean;
  /**
   * Held on its approval card until the person answers. Not running, and not done: muted, with the
   * card under the line saying what it would do.
   */
  waiting?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
}) {
  const tone = refused
    ? "text-status-problem"
    : failed
      ? "text-status-needs"
      : "text-muted-foreground";
  /*
   * A hairline hook, then a mark saying how it went, then what was done. Only a line that worked
   * gets the check, in the done colour; a group's own kinds come after the label, where they no
   * longer compete with the outcome.
   */
  const Mark =
    refused || failed || declined
      ? IconX
      : running || notYet || waiting
        ? IconClock
        : IconCircleCheck;
  const markTone =
    refused || failed
      ? tone
      : running || notYet || waiting || declined
        ? "text-muted-foreground"
        : "text-status-done";
  const text = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-[7px]">
      <svg
        aria-hidden
        className="mt-[9px] shrink-0 text-muted-foreground"
        height={14}
        viewBox="0 0 14 14"
        width={14}
      >
        <path
          d="M1 13V7a6 6 0 0 1 6-6h6"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.2}
        />
      </svg>
      <Mark
        aria-hidden
        className={cn("size-4 shrink-0", markTone)}
        stroke={2.2}
      />
      <span
        className={cn(
          "type-sub inline-flex min-w-0 items-baseline gap-1.5 font-medium",
          tone,
          running && "tool-line-running",
        )}
      >
        {/* Cut with an ellipsis rather than run past its row: a summary can be long. */}
        <span className="min-w-0 truncate">
          {declined
            ? `You declined: ${label}`
            : refused
              ? `Blocked: ${label}`
              : failed
                ? `${label}, didn't work`
                : notYet
                  ? `${label}, not done yet`
                  : waiting
                    ? `${label}, waiting for you`
                    : label}
        </span>
        {detail ? <span className="truncate opacity-70">{detail}</span> : null}
      </span>
      {icon ? (
        <span className="shrink-0 self-center text-muted-foreground">
          {icon}
        </span>
      ) : null}
    </span>
  );

  if (!children) return <div className="pl-1">{text}</div>;

  return (
    <details className="tool-line min-w-0 pl-1">
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state. The summary is the line, a finger's height tall, and the
       * chevron after the label says it opens.
       */}
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {text}
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-muted-foreground text-xs transition-transform motion-reduce:transition-none"
        >
          ▸
        </span>
      </summary>
      {/*
       * Indented to the label, past the hook and the mark, so the detail reads as belonging to it.
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      <div className="mt-2 ml-[45px] max-h-80 overflow-auto border-l pl-3 type-caption [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
        {children}
      </div>
    </details>
  );
}
