import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DEFAULT_SKIN, useSkinId } from "@/skins/store";

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
  notYet,
  children,
}: {
  /** Drawn before the label, small and muted. A group of steps puts its kinds here. */
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
  /**
   * Nothing was done yet, for an ordinary reason: a computer still starting turned the call away
   * before it reached anything. Muted like a success, because nothing went wrong, and labelled so it
   * does not read as one.
   */
  notYet?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
}) {
  const openbot = useSkinId() === DEFAULT_SKIN;
  const tone = refused
    ? "text-destructive"
    : failed
      ? "text-amber-600 dark:text-amber-500"
      : "text-muted-foreground";
  /*
   * In OpenBot's own look a line that opens is a card, its label in the text color, so what the Bot
   * did reads first and what it did it to second. A line that does not open stays a line.
   */
  const card = openbot && Boolean(children);

  const text = (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-sm",
        card && !refused && !failed ? "text-foreground" : tone,
        running && "tool-line-running",
      )}
    >
      {icon ? <span className="shrink-0 self-center">{icon}</span> : null}
      <span className={cn("shrink-0", card && "font-semibold")}>
        {refused
          ? `Blocked: ${label}`
          : failed
            ? `${label}, didn't work`
            : notYet
              ? `${label}, not done yet`
              : label}
      </span>
      {detail ? (
        <span
          className={cn(
            "truncate",
            card ? "font-normal text-muted-foreground" : "opacity-70",
          )}
        >
          {detail}
        </span>
      ) : null}
    </span>
  );

  if (!children) return <div className="my-1.5">{text}</div>;

  return (
    <details
      className={cn(
        "tool-line my-1.5 min-w-0",
        card &&
          "overflow-hidden rounded-xl border border-border bg-card px-3.5 py-2.5",
      )}
    >
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5">
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
        >
          ▸
        </span>
        {text}
      </summary>
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      <div className="mt-2 max-h-80 overflow-auto border-l pl-3 text-xs [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
        {children}
      </div>
    </details>
  );
}
