import {
  IconArrowUpRight,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconTerminal2,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { Badge, type Tone } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import { showComputerView } from "@/lib/computers/panel-view";
import { cn } from "@/lib/utils";
import { TERMINAL_BACKGROUND, TERMINAL_TEXT } from "./terminal-theme";

/**
 * A command the Bot ran, drawn as a terminal: the prompt and the command, what it printed, and how it
 * exited. In the chat, where each `computer_run_command` is one of these, and in the Activity pane
 * beside the screen, so the two say the same thing in the same shape.
 *
 * The frame is the one the chat's coding cards are drawn in (`coding-tool-cards.tsx`): a sidebar-
 * coloured card with a header row. The body is the live terminal's own dark ground and colours
 * (`terminal-theme.ts`), so a command in the chat reads as the terminal it ran in, and clicking it
 * opens that terminal in the Computer panel.
 */

/** Lines shown before the rest fold away. A line or two past it is shown rather than folded. */
const SHOWN_LINES = 4;

export type TerminalBlockStatus =
  | { state: "running" }
  | { state: "starting" }
  | { state: "exited"; exitCode: number; timedOut?: boolean }
  | { state: "blocked" | "declined" | "by-you" | "failed"; reason?: string };

function linesOf(text: string): string[] {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed ? trimmed.split("\n") : [];
}

/** How it ended, in the header: clear at a glance, and in words a person reads. */
function StatusBadge({ status }: { status: TerminalBlockStatus }) {
  const [tone, label, icon]: [Tone, string, ReactNode] =
    status.state === "running"
      ? ["neutral", "Running", null]
      : status.state === "starting"
        ? ["caution", "Computer starting", null]
        : status.state === "exited"
          ? status.timedOut
            ? ["caution", "Stopped: too long", null]
            : status.exitCode === 0
              ? [
                  "positive",
                  "Exit 0",
                  <IconCheck aria-hidden className="size-3" key="ok" />,
                ]
              : ["negative", `Exit ${status.exitCode}`, null]
          : status.state === "blocked"
            ? ["negative", "Blocked", null]
            : status.state === "declined"
              ? ["neutral", "Declined", null]
              : status.state === "by-you"
                ? ["neutral", "Done by you", null]
                : ["negative", "Didn't run", null];
  return (
    <span
      className={cn(
        "shrink-0",
        status.state === "running" ? "tool-line-running" : undefined,
      )}
    >
      <Badge tone={tone}>
        <span className="inline-flex items-center gap-1">
          {icon}
          {label}
        </span>
      </Badge>
    </span>
  );
}

export function TerminalBlock({
  computerId,
  command,
  output,
  status,
  truncated,
  label = "Ran a command",
  aside,
}: {
  /** Whose terminal clicking opens. Absent, the block is only a record. */
  computerId?: string;
  command: string;
  /** What it printed, or the reason it did not run. */
  output: string;
  status: TerminalBlockStatus;
  /** The far side cut the output short; this is the end of it. */
  truncated?: boolean;
  /** The header's words: "Ran a command", or a time in the Activity pane. */
  label?: ReactNode;
  /** Beside the status: a time, in the Activity pane. */
  aside?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const lines = linesOf(output);
  const folds = lines.length > SHOWN_LINES + 2;
  const shown = folds && !open ? lines.slice(-SHOWN_LINES) : lines;
  const finished = status.state !== "running" && status.state !== "starting";
  const ran = status.state === "exited";
  const openTerminal = computerId
    ? () => showComputerView(computerId, "terminal")
    : undefined;

  const body = (
    <>
      <div className="flex min-w-0 gap-2">
        <span
          aria-hidden
          className="shrink-0 select-none"
          style={{ color: TERMINAL_TEXT.prompt }}
        >
          $
        </span>
        <span className="min-w-0 whitespace-pre-wrap break-all">{command}</span>
      </div>
      {folds && !open ? (
        <div className="select-none" style={{ color: TERMINAL_TEXT.muted }}>
          … {lines.length - SHOWN_LINES} earlier lines
        </div>
      ) : null}
      {shown.length ? (
        <pre
          className="m-0 whitespace-pre-wrap break-words font-mono"
          style={{
            color: ran ? TERMINAL_TEXT.foreground : TERMINAL_TEXT.muted,
          }}
        >
          {shown.join("\n")}
        </pre>
      ) : finished && ran ? (
        <div className="italic" style={{ color: TERMINAL_TEXT.muted }}>
          It printed nothing.
        </div>
      ) : null}
    </>
  );

  return (
    <section
      aria-label={typeof label === "string" ? label : "Command"}
      className="my-1.5 flex w-full min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-sidebar p-1.5 dark:border-white/10"
    >
      <header className="flex h-7 min-w-0 items-center gap-2 px-1 text-xs">
        <IconTerminal2
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {label}
        </span>
        {aside}
        <StatusBadge status={status} />
        {openTerminal ? (
          <Button
            aria-label="Open in the terminal"
            className="text-muted-foreground"
            onClick={openTerminal}
            size="icon-xs"
            title="Open in the terminal"
            variant="ghost"
          >
            <IconArrowUpRight />
          </Button>
        ) : null}
      </header>
      <div
        className="min-w-0 overflow-hidden rounded-lg ring-1 ring-black/10 dark:ring-white/15"
        style={{ background: TERMINAL_BACKGROUND }}
      >
        {openTerminal ? (
          <button
            className="block w-full cursor-pointer px-3 py-2 text-left font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={openTerminal}
            style={{ color: TERMINAL_TEXT.foreground }}
            type="button"
          >
            {body}
          </button>
        ) : (
          <div
            className="px-3 py-2 font-mono text-xs leading-5"
            style={{ color: TERMINAL_TEXT.foreground }}
          >
            {body}
          </div>
        )}
        {folds || truncated ? (
          <div className="flex items-center justify-between gap-2 border-white/10 border-t px-1.5 py-1">
            {folds ? (
              <Button
                aria-expanded={open}
                className="text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => setOpen((was) => !was)}
                size="xs"
                variant="ghost"
              >
                {open ? <IconChevronUp /> : <IconChevronDown />}
                {open ? "Show less" : `Show all ${lines.length} lines`}
              </Button>
            ) : (
              <span />
            )}
            {truncated ? (
              <span className="px-1.5 text-[11px] text-white/60">
                Long output. This is the end of it.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** What a command's result says about how it ended, for the block's badge. */
export function commandStatus(input: {
  running: boolean;
  starting?: boolean;
  refused?: boolean;
  declined?: boolean;
  byYou?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  failed?: boolean;
}): TerminalBlockStatus {
  if (input.running) return { state: "running" };
  if (input.starting) return { state: "starting" };
  if (input.declined) return { state: "declined" };
  if (input.refused) return { state: "blocked" };
  if (input.byYou) return { state: "by-you" };
  if (typeof input.exitCode === "number")
    return {
      state: "exited",
      exitCode: input.exitCode,
      ...(input.timedOut ? { timedOut: true } : {}),
    };
  return input.failed ? { state: "failed" } : { state: "exited", exitCode: 0 };
}
