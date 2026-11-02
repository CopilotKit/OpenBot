import {
  IconChevronDown,
  IconChevronUp,
  IconFilePlus,
  IconFileText,
  IconFolderSearch,
  IconListCheck,
  IconPencil,
  IconSearch,
  IconTerminal2,
} from "@tabler/icons-react";
import { structuredPatch } from "diff";
import { type ReactNode, useState } from "react";
import { byPosition } from "@/components/gallery/positions";
import { Badge, GalleryFrame } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import { asText } from "@/lib/plugins/tool-result";
import { cn } from "@/lib/utils";
import { ToolLine } from "./tool-line";

/**
 * How a coding harness's own tools read in a conversation: a command with its output, a file edit
 * as a diff, a plan as a checklist.
 *
 * These are the Claude Agent SDK's built-in tools (`agent-claude-sdk/`), which reach the transcript
 * named as Claude Code names them, with Claude Code's arguments, and with the text Claude Code hands
 * the model as their result. The look follows Claude Code's own pieces, built from OpenBot's: the
 * frame is the one a fenced code block is drawn in, so code a Bot wrote and code a Bot ran read as
 * one family.
 */

/** Where a call has got to. A call with no result is running only while its turn is. */
export type CodingOutcome =
  | { state: "running" | "stopped"; text: "" }
  | { state: "done"; text: string }
  | { state: "failed"; text: string; exitCode?: number };

/**
 * A result, and whether the tool said it failed.
 *
 * `ag-ui-claude-sdk` has nowhere in an AG-UI result to put Claude Code's `is_error`, so while the
 * turn streams it wraps a failed result as `{"error": true, "content": "..."}`, and adds
 * `"error": true` to one that was already a JSON object. The history it sends when the turn ends
 * carries the bare text, so a failure is also known by Claude Code's own marks on it: a command's
 * exit code on the first line, and `<tool_use_error>` around anything else that was refused.
 */
export function codingOutcome(
  result: string | undefined,
  arriving: boolean,
): CodingOutcome {
  if (result === undefined)
    return { state: arriving ? "running" : "stopped", text: "" };
  const answer = asText(result);
  const flagged = flaggedFailure(answer);
  const tagged = /^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/.exec(
    flagged ?? answer,
  )?.[1];
  const text = tagged ?? flagged ?? answer;
  const exit = /^Exit code (\d+)\n?/.exec(text);
  if (exit)
    return {
      state: "failed",
      text: text.slice(exit[0].length),
      exitCode: Number(exit[1]),
    };
  if (flagged !== undefined || tagged !== undefined)
    return { state: "failed", text };
  return { state: "done", text };
}

function flaggedFailure(answer: string): string | undefined {
  if (!answer.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const { error, ...rest } = parsed as Record<string, unknown>;
    if (error !== true) return undefined;
    return typeof rest.content === "string"
      ? rest.content
      : JSON.stringify(rest, null, 2);
  } catch {
    return undefined;
  }
}

function linesOf(text: string): string[] {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed ? trimmed.split("\n") : [];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The name of the file, which is what a person scans for; the whole path is its tooltip. */
function fileName(path: string | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/**
 * The frame, drawn as Streamdown draws a fenced code block: a sidebar-coloured card holding a
 * header row and, under it, the body on the page's own background.
 */
function CodingFrame({
  label,
  icon,
  title,
  aside,
  children,
}: {
  /** What happened, for a screen reader: the header shows it as an icon. */
  label: string;
  icon: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="my-1.5 flex w-full min-w-0 flex-col gap-2 rounded-xl border border-border bg-sidebar p-2"
    >
      <header className="flex h-8 min-w-0 items-center gap-2 px-1 text-xs">
        <span aria-hidden className="shrink-0 text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{title}</span>
        {aside}
      </header>
      {children ? (
        <div className="min-w-0 overflow-hidden rounded-md border border-border bg-background">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** Running, stopped or failed, at the end of a header. Done says nothing: the body is the answer. */
function OutcomeStatus({
  outcome,
  running,
}: {
  outcome: CodingOutcome;
  /** The word while it runs: "Running", "Editing", "Writing". */
  running: string;
}) {
  if (outcome.state === "running")
    return (
      <span className="tool-line-running shrink-0 text-xs text-muted-foreground">
        {running}
      </span>
    );
  if (outcome.state === "stopped")
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        Not completed
      </span>
    );
  if (outcome.state === "failed")
    return (
      <span className="shrink-0 text-xs text-amber-600 dark:text-amber-500">
        {outcome.exitCode === undefined
          ? "Didn't work"
          : `Exit code ${outcome.exitCode}`}
      </span>
    );
  return null;
}

/**
 * The first few rows, and a control for the rest. A row or two past the limit is shown rather than
 * hidden behind a button that would reveal less than it takes up.
 */
function Folded({
  total,
  limit,
  children,
}: {
  total: number;
  limit: number;
  children: (shown: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const folds = total > limit + 2;
  return (
    <>
      {children(folds && !open ? limit : total)}
      {folds ? (
        <Button
          aria-expanded={open}
          className="mx-1.5 mb-1.5 text-muted-foreground"
          onClick={() => setOpen((was) => !was)}
          size="xs"
          variant="ghost"
        >
          {open ? <IconChevronUp /> : <IconChevronDown />}
          {open
            ? "Show less"
            : `Show ${plural(total - limit, "more line", "more lines")}`}
        </Button>
      ) : null}
    </>
  );
}

const OUTPUT_LINES = 6;

/** A shell command: the command on one line, then what it printed. */
export function CommandCard({
  command,
  outcome,
}: {
  command: string | undefined;
  outcome: CodingOutcome;
}) {
  const lines = linesOf(outcome.text);
  return (
    <CodingFrame
      aside={<OutcomeStatus outcome={outcome} running="Running" />}
      icon={<IconTerminal2 className="size-4" />}
      label="Ran a command"
      title={<span title={command}>{command}</span>}
    >
      {lines.length ? (
        <Folded limit={OUTPUT_LINES} total={lines.length}>
          {(shown) => (
            <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5">
              {lines.slice(0, shown).join("\n")}
            </pre>
          )}
        </Folded>
      ) : null}
    </CodingFrame>
  );
}

type DiffRow = { kind: "add" | "del" | "same" | "gap"; text: string };

/**
 * One edit as unified diff rows: the lines it took out, the lines it put in, and up to three
 * unchanged lines around them. The arguments carry the replaced text and its replacement, not the
 * file, so there are no line numbers to show.
 */
function diffRows(before: string, after: string): DiffRow[] {
  const patch = structuredPatch("", "", before, after, undefined, undefined, {
    context: 3,
  });
  const rows: DiffRow[] = [];
  for (const [index, hunk] of patch.hunks.entries()) {
    if (index > 0) rows.push({ kind: "gap", text: "" });
    for (const line of hunk.lines) {
      // "\ No newline at end of file" is about the patch format, not the code.
      if (line.startsWith("\\")) continue;
      const mark = line.charAt(0);
      rows.push({
        kind: mark === "+" ? "add" : mark === "-" ? "del" : "same",
        text: line.slice(1),
      });
    }
  }
  return rows;
}

const ROW_TONES = {
  add: "bg-emerald-500/10 dark:bg-emerald-500/15",
  del: "bg-red-500/10 dark:bg-red-500/15",
  same: "text-muted-foreground",
  gap: "text-muted-foreground",
} as const;

const MARK_TONES = {
  add: "text-emerald-700 dark:text-emerald-400",
  del: "text-red-700 dark:text-red-400",
} as const;

const DIFF_ROWS = 12;

/**
 * A file change as a diff: an edit's replaced lines in red and their replacements in green, a new
 * file as all green.
 */
export function DiffCard({
  kind,
  path,
  changes,
  replaceAll = false,
  outcome,
}: {
  kind: "edit" | "write";
  path: string | undefined;
  /** Each replacement, in order. A write is one, from nothing. */
  changes: readonly { before: string; after: string }[];
  /**
   * The edit replaced every occurrence of its text, not only the first. The diff shows one
   * replacement either way, because the arguments carry the text and not the file, so the header
   * says so.
   */
  replaceAll?: boolean;
  outcome: CodingOutcome;
}) {
  const rows: DiffRow[] = [];
  for (const change of changes) {
    if (rows.length) rows.push({ kind: "gap", text: "" });
    rows.push(...diffRows(change.before, change.after));
  }
  const added = rows.filter((row) => row.kind === "add").length;
  const removed = rows.filter((row) => row.kind === "del").length;
  const Icon = kind === "write" ? IconFilePlus : IconPencil;
  return (
    <CodingFrame
      aside={
        <>
          {replaceAll ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              All occurrences
            </span>
          ) : null}
          {added || removed ? (
            <span className="flex shrink-0 gap-1.5 font-mono text-xs">
              {added ? <span className={MARK_TONES.add}>+{added}</span> : null}
              {removed ? (
                <span className={MARK_TONES.del}>−{removed}</span>
              ) : null}
            </span>
          ) : null}
          <OutcomeStatus
            outcome={outcome}
            running={kind === "write" ? "Writing" : "Editing"}
          />
        </>
      }
      icon={<Icon className="size-4" />}
      label={kind === "write" ? "Wrote a file" : "Edited a file"}
      title={<span title={path}>{fileName(path)}</span>}
    >
      {rows.length ? (
        <Folded limit={DIFF_ROWS} total={rows.length}>
          {(shown) => (
            /*
             * Lines keep their indentation and scroll sideways, as a code block's do. The inner box is
             * as wide as the longest line, so a tinted row is tinted all the way across.
             */
            <div className="overflow-x-auto py-1.5 font-mono text-xs leading-5">
              <div className="w-max min-w-full">
                {byPosition(rows.slice(0, shown)).map(({ item: row, key }) =>
                  row.kind === "gap" ? (
                    <div
                      aria-hidden
                      className={cn("px-3", ROW_TONES.gap)}
                      key={key}
                    >
                      ⋯
                    </div>
                  ) : (
                    <div className={cn("flex", ROW_TONES[row.kind])} key={key}>
                      <span
                        aria-hidden
                        className={cn(
                          "w-6 shrink-0 select-none text-center",
                          row.kind === "same" ? "" : MARK_TONES[row.kind],
                        )}
                      >
                        {row.kind === "add"
                          ? "+"
                          : row.kind === "del"
                            ? "−"
                            : ""}
                      </span>
                      <span className="flex-1 whitespace-pre pr-3">
                        {row.kind === "same" ? null : (
                          <span className="sr-only">
                            {row.kind === "add" ? "Added: " : "Removed: "}
                          </span>
                        )}
                        {row.text || " "}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </Folded>
      ) : null}
    </CodingFrame>
  );
}

type Todo = {
  content?: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

const TODO_STATES = {
  completed: "Done",
  in_progress: "In progress",
  pending: "Not started",
} as const;

/**
 * A Bot's plan, as the gallery's checklist draws one, with the step it is on marked as well as the
 * ones it has finished.
 */
export function TodoCard({ todos }: { todos: readonly Todo[] }) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <GalleryFrame
      action={
        <Badge
          tone={
            done === todos.length && todos.length > 0 ? "positive" : "neutral"
          }
        >
          {done} of {todos.length}
        </Badge>
      }
      title="To-dos"
    >
      <ul className="space-y-2">
        {byPosition(todos).map(({ item: todo, key }) => {
          const status =
            todo.status && todo.status in TODO_STATES ? todo.status : "pending";
          return (
            <li className="flex items-start gap-2.5 text-sm" key={key}>
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px]",
                  status === "completed"
                    ? "border-transparent bg-emerald-500 text-white"
                    : status === "in_progress"
                      ? "border-foreground/60"
                      : "border-border",
                )}
              >
                {status === "completed" ? (
                  "✓"
                ) : status === "in_progress" ? (
                  <span className="size-1.5 rounded-full bg-foreground" />
                ) : null}
              </span>
              <span
                className={cn(
                  "min-w-0",
                  status === "completed" &&
                    "text-muted-foreground line-through",
                  status === "in_progress" && "font-medium",
                )}
              >
                {todo.content}
                <span className="sr-only">, {TODO_STATES[status]}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </GalleryFrame>
  );
}

/**
 * A tool that only looked at something, as one line in the transcript's own rhythm: what it did and
 * how much, then what to, with what came back behind the disclosure.
 */
function LookLine({
  icon: Icon,
  outcome,
  doing,
  did,
  detail,
  shows = true,
}: {
  icon: typeof IconSearch;
  outcome: CodingOutcome;
  doing: string;
  did: string;
  detail: string | undefined;
  /** Whether what came back is worth opening. A task tool's answer only confirms the call. */
  shows?: boolean;
}) {
  const output = shows ? outcome.text.replace(/\s+$/, "") : "";
  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      failed={outcome.state === "failed"}
      icon={<Icon aria-hidden className="size-4" />}
      label={
        outcome.state === "done" || outcome.state === "failed" ? did : doing
      }
      notYet={outcome.state === "stopped"}
      running={outcome.state === "running"}
    >
      {output ? (
        <pre className="font-mono whitespace-pre-wrap break-words">
          {output}
        </pre>
      ) : undefined}
    </ToolLine>
  );
}

/** Lines of a file as Read returns them, each led by its number and a tab (an arrow, before). */
function numberedLines(text: string): number {
  return text.split("\n").filter((line) => /^\s*\d+(\t|→)/.test(line)).length;
}

export function ReadLine({
  path,
  outcome,
}: {
  path: string | undefined;
  outcome: CodingOutcome;
}) {
  const count = outcome.state === "done" ? numberedLines(outcome.text) : 0;
  return (
    <LookLine
      detail={fileName(path)}
      did={count ? `Read ${plural(count, "line", "lines")}` : "Read"}
      doing="Reading"
      icon={IconFileText}
      outcome={outcome}
    />
  );
}

type GrepMode = "content" | "files_with_matches" | "count";

/**
 * How much a search found, read from the summary Claude Code writes for the model: a list of files
 * by default, matching lines with `content`, and a total with `count`.
 */
function grepFound(text: string, mode: GrepMode): string {
  const trimmed = text.trim();
  const files = mode === "files_with_matches";
  if (!trimmed || /^No (matches|files) found/.test(trimmed))
    return files ? "Found no files" : "Found no matches";
  if (files) {
    const found = /^Found (\d+) files?/.exec(trimmed);
    const count = found
      ? Number(found[1])
      : trimmed.split("\n").filter(Boolean).length;
    return `Found ${plural(count, "file", "files")}`;
  }
  const lines = trimmed.split("\n");
  const total = /Found (\d+) total occurrences?/.exec(trimmed);
  const count =
    mode === "count"
      ? total
        ? Number(total[1])
        : lines.reduce(
            (sum, line) => sum + Number(/:(\d+)$/.exec(line)?.[1] ?? 0),
            0,
          )
      : lines.filter(
          (line) => line && line !== "--" && !line.startsWith("[Showing"),
        ).length;
  return `Found ${plural(count, "match", "matches")}`;
}

export function GrepLine({
  pattern,
  path,
  mode,
  outcome,
}: {
  pattern: string | undefined;
  path: string | undefined;
  mode: GrepMode | undefined;
  outcome: CodingOutcome;
}) {
  const where = fileName(path);
  return (
    <LookLine
      detail={
        pattern === undefined
          ? undefined
          : `"${pattern}"${where ? ` in ${where}` : ""}`
      }
      did={
        outcome.state === "done"
          ? grepFound(outcome.text, mode ?? "files_with_matches")
          : "Searched"
      }
      doing="Searching"
      icon={IconSearch}
      outcome={outcome}
    />
  );
}

export function GlobLine({
  pattern,
  outcome,
}: {
  pattern: string | undefined;
  outcome: CodingOutcome;
}) {
  const files =
    outcome.state === "done" && !/^No files found/.test(outcome.text.trim())
      ? linesOf(outcome.text).filter((line) => !line.startsWith("(")).length
      : 0;
  return (
    <LookLine
      detail={pattern}
      did={
        outcome.state === "done"
          ? files
            ? `Found ${plural(files, "file", "files")}`
            : "Found no files"
          : "Looked for files"
      }
      doing="Looking for files"
      icon={IconFolderSearch}
      outcome={outcome}
    />
  );
}

/**
 * One step of a plan kept with Claude Code's task tools, which add a task, or change one, per call.
 * The task's own words when the call carries them; an update names only the task's number.
 */
export function TaskLine({
  label,
  doing,
  subject,
  outcome,
}: {
  label: string;
  doing: string;
  subject: string | undefined;
  outcome: CodingOutcome;
}) {
  return (
    <LookLine
      detail={subject}
      did={label}
      doing={doing}
      icon={IconListCheck}
      outcome={outcome}
      shows={false}
    />
  );
}
