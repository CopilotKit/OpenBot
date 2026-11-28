import type { ReactNode, SyntheticEvent } from "react";
import { useToolPlace } from "@/lib/copilot/tool-place";

/**
 * The lines a person opened, by the tool call (or the group of calls) each one draws.
 *
 * KEPT OUTSIDE THE LINE, so a line the person opened stays open while they read it. The SDK draws a
 * tool call through a renderer it may replace, and the transcript can draw a row again, either of
 * which builds the `<details>` anew; held in the element alone, its open state went with it and the
 * output the person was reading folded shut under them. Kept for this page only: a reload, or a
 * conversation opened again later, starts with every line folded, as a reply is first drawn.
 */
const opened = new Set<string>();

/** Forget every line opened on this page, as a reload does. For tests. */
export function forgetOpenedLines(): void {
  opened.clear();
}

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
/** A label this short stays on one line: "Asked you", "Searched the web", "Fetch". */
const SHORT_LABEL = 32;

export function ToolLine({
  icon,
  label,
  attempted,
  detail,
  running,
  refused,
  failed,
  failedLabel,
  notYet,
  interrupted,
  byYou,
  bare,
  detailOnOneLine,
  openKey,
  children,
}: {
  /** Drawn before the label, small and muted. A group of steps puts its kinds here. */
  icon?: ReactNode;
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /**
   * What was tried, for a step that was refused: "Save file", not "Saved file". A refused step did
   * not happen, so its line says what was attempted. Without it the label is used.
   */
  attempted?: string;
  /**
   * What it was done to. Muted, and truncated rather than wrapped, except on a refused or failed
   * step, where it is the reason and wraps in full.
   */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /**
   * What a failed step says in place of "<label>, didn't work", where the label would claim the step
   * happened: a file that was not saved reads "Didn't save a file", not "Saved a file, didn't work".
   */
  failedLabel?: string;
  /**
   * Nothing was done yet, for an ordinary reason: a computer still starting turned the call away
   * before it reached anything. Muted like a success, because nothing went wrong, and labelled so it
   * does not read as one.
   */
  notYet?: boolean;
  /**
   * The step was under way when its run was cut off, so nobody knows how it ended. Muted, because
   * nothing is known to have gone wrong, and labelled with what was tried so it reads neither as
   * done nor as still happening.
   */
  interrupted?: boolean;
  /**
   * The step was handed to the person and they did it themselves. Muted like a success, because it
   * was done, and labelled so it does not read as the Bot having done it.
   */
  byYou?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
  /**
   * The expanded part grows with what it holds instead of scrolling, for children that bound
   * themselves: a group's list of steps, each of which folds its own result. One scrolling box
   * inside another left two scrollbars side by side.
   */
  bare?: boolean;
  /**
   * The detail names what the step acted on (a command, a file), not why it failed, so it stays on
   * one line, truncated, even on a failed step. The reason is in what the line opens to.
   */
  detailOnOneLine?: boolean;
  /**
   * What this line is remembered by while the page is open, so it stays open when it is drawn again.
   * Inside a tool call the transcript draws, the call's own id, unless one is given.
   */
  openKey?: string;
}) {
  const place = useToolPlace();
  const key = openKey ?? place?.toolCallId;
  const tone = refused
    ? "text-destructive"
    : failed
      ? "text-warning"
      : "text-muted-foreground";

  /*
   * A REFUSED OR FAILED STEP'S DETAIL IS THE REASON, AND A REASON CUT OFF SAYS NOTHING. Truncated,
   * "budget.xlsx can't be sent. Bots c..." left a person on a phone not knowing why, nor what would
   * work. So on those rows the detail wraps in full, and the row wraps too, putting it under the
   * label when it does not fit beside it. Every other row keeps one line, its detail truncated.
   */
  const saysWhy =
    (refused === true || failed === true) &&
    Boolean(detail) &&
    detailOnOneLine !== true;

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      } ${saysWhy ? "flex-wrap" : ""}`}
    >
      {icon ? <span className="shrink-0 self-center">{icon}</span> : null}
      {/*
       * Free to shrink, so a long label (a folded run's "Read 1 file, searched for 2 patterns and
       * listed 1 directory") wraps in a phone-width column instead of running past it. The detail
       * shrinks a hundred times faster, but even a hundred times faster still took a few pixels from
       * the label, enough to break "Asked you" over two lines beside a long question. So a label of a
       * few words never shrinks at all, and only a long one is left free to wrap.
       */}
      <span
        className={
          label.length <= SHORT_LABEL ? "shrink-0 whitespace-nowrap" : "min-w-0"
        }
      >
        {refused
          ? `Blocked: ${attempted ?? label}`
          : failed
            ? (failedLabel ?? `${label}, didn't work`)
            : interrupted
              ? `${attempted ?? label}, interrupted`
              : notYet
                ? `${label}, not done yet`
                : byYou
                  ? `${label}, done by you`
                  : label}
      </span>
      {detail ? (
        <span
          className={
            saysWhy
              ? "min-w-0 break-words opacity-70"
              : "min-w-0 shrink-[100] truncate opacity-70"
          }
        >
          {detail}
        </span>
      ) : null}
    </span>
  );

  if (!children) return <div className="my-1.5">{text}</div>;

  const remember = key
    ? (event: SyntheticEvent<HTMLDetailsElement>) => {
        if (event.currentTarget.open) opened.add(key);
        else opened.delete(key);
      }
    : undefined;

  return (
    <details
      className="tool-line my-1.5 min-w-0"
      // Folded until the person opens it, and open again if it is drawn anew while they read it.
      open={key !== undefined && opened.has(key)}
      onToggle={remember}
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
      <div
        className={`mt-2 border-l pl-3 text-xs ${bare ? "" : "max-h-80 overflow-auto"} [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium`}
      >
        {children}
      </div>
    </details>
  );
}
