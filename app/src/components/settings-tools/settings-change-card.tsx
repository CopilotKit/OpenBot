import {
  IconArrowDown,
  IconSettings,
  IconUsers,
  type TablerIcon,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Badge, type Tone } from "@/components/gallery/frame";
import { cn } from "@/lib/utils";

/**
 * The shared card for a change to OpenBot's settings: what it was, what it is now, in the words the
 * settings screens use, and who else it reaches.
 *
 * Drawn twice for one change: on the approval card while it waits for the person (`SettingsChangeRows`
 * inside the decision card), and as the call's own card once it ran or was refused. Built for the
 * chat column: before sits over after, never beside it, so a long value wraps instead of squeezing.
 */

/** One row of a change, as the server words it. */
export type SettingsChangeRow = {
  /** The setting's name on its screen, e.g. "Standing instructions". */
  label: string;
  /** The value before, in words. Null when it wasn't set. */
  before: string | null;
  /** The value after, in words. Null when it's cleared. */
  after: string | null;
};

/**
 * A change, as a write's output and the approval card carry it. `changes` is the change in words;
 * without it the card lists the top-level values of `before` and `after` that differ.
 */
export type SettingsChange = {
  summary: string;
  before?: unknown;
  after?: unknown;
  changes?: SettingsChangeRow[];
  affected?: string;
};

/** Where a change is, as the badge says it. */
export type SettingsChangeState =
  | "running"
  | "waiting"
  | "done"
  | "refused"
  | "failed";

const STATE: Record<SettingsChangeState, { label: string; tone: Tone }> = {
  running: { label: "Changing", tone: "neutral" },
  waiting: { label: "Waiting for you", tone: "caution" },
  done: { label: "Changed", tone: "positive" },
  refused: { label: "Not changed", tone: "negative" },
  failed: { label: "Didn't work", tone: "negative" },
};

/** A change as the server sent it, or null when it isn't one. */
export function settingsChangeOf(value: unknown): SettingsChange | null {
  if (!value || typeof value !== "object") return null;
  const change = value as Record<string, unknown>;
  if (typeof change.summary !== "string") return null;
  const rows = Array.isArray(change.changes)
    ? change.changes.flatMap((row): SettingsChangeRow[] => {
        if (!row || typeof row !== "object") return [];
        const { label, before, after } = row as Record<string, unknown>;
        if (typeof label !== "string") return [];
        return [
          {
            label,
            before: typeof before === "string" ? before : null,
            after: typeof after === "string" ? after : null,
          },
        ];
      })
    : undefined;
  return {
    summary: change.summary,
    before: change.before,
    after: change.after,
    ...(rows ? { changes: rows } : {}),
    ...(typeof change.affected === "string"
      ? { affected: change.affected }
      : {}),
  };
}

/** A key as a label: `standingInstructions` reads "Standing instructions". */
function labelOf(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value in words. */
function inWords(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.length === 0 ? null : value.map(inWords).join(", ");
  return JSON.stringify(value);
}

/** The rows to draw: the server's words, or the top-level values that differ. */
export function changeRows(change: SettingsChange): SettingsChangeRow[] {
  if (change.changes && change.changes.length > 0) return change.changes;
  const before =
    change.before && typeof change.before === "object"
      ? (change.before as Record<string, unknown>)
      : {};
  const after =
    change.after && typeof change.after === "object"
      ? (change.after as Record<string, unknown>)
      : {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => inWords(before[key]) !== inWords(after[key]))
    .map((key) => ({
      label: labelOf(key),
      before: inWords(before[key]),
      after: inWords(after[key]),
    }));
}

/**
 * The before and after, row by row, and who it reaches. For the approval card and the result card.
 */
export function SettingsChangeRows({
  change,
  state = "done",
}: {
  change: SettingsChange;
  state?: SettingsChangeState;
}) {
  const rows = changeRows(change);
  // Not made: the after is what would have been, so it is drawn as a proposal, never as a fact.
  const proposed = state !== "done";
  return (
    <div className="flex flex-col gap-3" data-slot="settings-change-rows">
      {rows.length > 0 ? (
        <dl className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
          {rows.map((row) => (
            <div
              className="flex flex-col gap-1.5 px-3 py-2.5"
              data-setting={row.label}
              key={row.label}
            >
              <dt className="text-muted-foreground text-xs">{row.label}</dt>
              <dd className="flex flex-col gap-1 text-sm">
                <span
                  className={cn(
                    "break-words text-muted-foreground",
                    row.before !== null && "line-through decoration-1",
                  )}
                  data-value="before"
                >
                  {row.before ?? "Not set"}
                </span>
                <IconArrowDown
                  aria-hidden
                  className="size-3.5 text-muted-foreground"
                />
                <span
                  className={cn(
                    "break-words font-medium",
                    proposed && "text-foreground/80",
                  )}
                  data-value="after"
                >
                  {row.after ?? "Not set"}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {change.affected ? (
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
          <IconUsers aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{change.affected}</span>
        </p>
      ) : null}
    </div>
  );
}

/** A screen to open, as a link at the foot of a card. */
export type SettingsScreenLink = { to: string; label: string };

/**
 * The card a settings change draws in the conversation: what changed (or would have), its state,
 * and the screen it lives on.
 */
export function SettingsChangeCard({
  title,
  icon: Icon = IconSettings,
  change,
  state,
  reason,
  link,
  children,
}: {
  /** What was changed, as its screen is titled: "Your settings", "Organization settings". */
  title: string;
  icon?: TablerIcon;
  /** Null while it runs, or when it was refused before a change was worked out. */
  change: SettingsChange | null;
  state: SettingsChangeState;
  /** Why it was refused or didn't work, in the person's words. */
  reason?: string;
  link?: SettingsScreenLink;
  children?: ReactNode;
}) {
  const badge = STATE[state];
  return (
    <figure
      aria-busy={state === "running"}
      className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
      data-settings-card
      data-state={state}
    >
      <figcaption className="flex items-start gap-3 border-border border-b px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="truncate font-medium text-sm">{title}</p>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          {change?.summary ? (
            <p className="text-muted-foreground text-xs">{change.summary}</p>
          ) : null}
        </div>
      </figcaption>
      <div className="flex flex-col gap-3 px-4 py-3">
        {reason ? (
          <p
            className={cn(
              "text-sm",
              state === "failed" || state === "refused"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            role={state === "failed" ? "alert" : "status"}
          >
            {reason}
          </p>
        ) : null}
        {change ? <SettingsChangeRows change={change} state={state} /> : null}
        {children}
        {link ? (
          <Link
            className="self-start text-sm underline underline-offset-2 hover:text-foreground/80"
            to={link.to as never}
          >
            {link.label}
          </Link>
        ) : null}
      </div>
    </figure>
  );
}
