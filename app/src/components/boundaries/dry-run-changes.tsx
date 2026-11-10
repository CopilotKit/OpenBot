import { IconDeviceDesktop, IconPlug } from "@tabler/icons-react";
import type { ReactNode } from "react";
import {
  type AuditEvent,
  BotCell,
  StartedByCell,
  WhatCell,
  whenText,
} from "@/components/audit/audit-cells";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import type { DryRunChange } from "@/lib/computers/queries";
import { cn } from "@/lib/utils";

/**
 * A change as the audit row it was replayed from, so Audit's own cells draw it.
 *
 * The preview is a list of rows from the trail, and an admin who opens Audit next to it should find
 * each one said the same way: the same action in words, the same app tool or command under it, the
 * same "Started by a routine". Only what those cells read is filled in.
 */
function auditRowOf(change: DryRunChange): AuditEvent {
  const app = change.kind === "app";
  return {
    id: change.id,
    actorUserId: null,
    initiatorKind: change.initiator.kind,
    initiatorId: change.initiator.id || null,
    eventType: app ? "mcp.call_succeeded" : "computer.action_allowed",
    targetType: app ? "mcp_tool" : "computer",
    targetId: app ? change.action : change.bot,
    createdAt: change.createdAt,
    payload: {
      bot: change.bot,
      ...(app ? {} : { action: change.action, page: change.page }),
      ...(change.element ? { element: change.element } : {}),
      ...(change.command ? { command: change.command } : {}),
      ...(change.file ? { file: change.file } : {}),
    },
  };
}

/**
 * Actions already on the trail that a rule decides differently, one row each: a Bot's computer
 * actions and its app calls in one list, newest first, each marked by where it acted.
 *
 * `total` is the count over everything scanned. The list is capped by the server, and a reader who
 * stops at the rows should not believe the rows are the whole answer, so the gap is said under them.
 * `verdict` is what the rule does to each, in the Decision column's words and colour.
 */
export function DryRunChanges({
  changes,
  total,
  verdict,
}: {
  changes: DryRunChange[];
  total: number;
  verdict: string;
}) {
  if (changes.length === 0) return null;
  return (
    <ReplayRows
      rows={changes.map((change) => ({
        id: change.id,
        event: auditRowOf(change),
        media:
          change.kind === "app"
            ? { icon: <IconPlug />, label: "App call" }
            : { icon: <IconDeviceDesktop />, label: "Computer action" },
        verdict,
      }))}
      total={total}
    />
  );
}

/** One replayed action: its audit row, the mark for where it acted, and what the rule does to it. */
export type ReplayRow = {
  id: string;
  /** The row from the trail, or one shaped like it, which Audit's own cells draw. */
  event: AuditEvent;
  media: { icon: ReactNode; label: string };
  verdict: string;
  /** The verdict's colour. The refusal colour unless given. */
  verdictClassName?: string;
  /** A line under the row's own, such as what the person answered when they were asked. */
  note?: string;
};

/**
 * Replayed actions in Audit's own cells, one row each, the verdict on the right. Shared by a
 * boundary's preview and team approval rules' backtest. The Bots' names are only asked for when there
 * are rows to name.
 */
export function ReplayRows({
  rows,
  total,
}: {
  rows: ReplayRow[];
  /** The count over everything scanned, said under the rows when the list is capped below it. */
  total: number;
}) {
  const nameFor = useBotNames();
  return (
    <>
      <PageRows>
        {rows.map((row, index) => (
          <div key={row.id}>
            <Item size="sm">
              {/*
               * Held against the first line, as a row with a description holds it: these rows run
               * to three lines, and a centred mark drifts away from the action it names.
               */}
              <ItemMedia
                aria-label={row.media.label}
                className="translate-y-0.5 self-start"
                role="img"
                variant="icon"
              >
                {row.media.icon}
              </ItemMedia>
              <ItemContent className="min-w-0">
                <WhatCell event={row.event} storedName />
                <div className="mt-0.5 text-xs">
                  <BotCell event={row.event} nameFor={nameFor} />
                  <span className="text-muted-foreground"> · </span>
                  <StartedByCell event={row.event} nameFor={nameFor} />
                  <span className="text-muted-foreground">
                    {" "}
                    · {whenText(row.event)}
                  </span>
                </div>
                {row.note ? (
                  <div className="mt-0.5 text-muted-foreground text-xs">
                    {row.note}
                  </div>
                ) : null}
              </ItemContent>
              <ItemActions className="self-start">
                <span
                  className={cn(
                    "font-medium text-sm",
                    row.verdictClassName ?? "text-destructive",
                  )}
                >
                  {row.verdict}
                </span>
              </ItemActions>
            </Item>
            {index !== rows.length - 1 && <Separator />}
          </div>
        ))}
      </PageRows>
      {total > rows.length ? (
        <p className="mt-2 text-muted-foreground text-xs">
          Showing the first {rows.length} of {total}.
        </p>
      ) : null}
    </>
  );
}
