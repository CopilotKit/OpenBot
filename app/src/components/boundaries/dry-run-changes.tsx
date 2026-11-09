import { IconDeviceDesktop, IconPlug } from "@tabler/icons-react";
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
  return <ChangeRows changes={changes} total={total} verdict={verdict} />;
}

/** The rows themselves, apart so the Bots' names are only asked for when there are rows to name. */
function ChangeRows({
  changes,
  total,
  verdict,
}: {
  changes: DryRunChange[];
  total: number;
  verdict: string;
}) {
  const nameFor = useBotNames();
  return (
    <>
      <PageRows>
        {changes.map((change, index) => {
          const row = auditRowOf(change);
          return (
            <div key={change.id}>
              <Item size="sm">
                {/*
                 * Held against the first line, as a row with a description holds it: these rows run
                 * to three lines, and a centred mark drifts away from the action it names.
                 */}
                <ItemMedia
                  aria-label={
                    change.kind === "app" ? "App call" : "Computer action"
                  }
                  className="translate-y-0.5 self-start"
                  role="img"
                  variant="icon"
                >
                  {change.kind === "app" ? <IconPlug /> : <IconDeviceDesktop />}
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <WhatCell event={row} storedName />
                  <div className="mt-0.5 text-xs">
                    <BotCell event={row} nameFor={nameFor} />
                    <span className="text-muted-foreground"> · </span>
                    <StartedByCell event={row} nameFor={nameFor} />
                    <span className="text-muted-foreground">
                      {" "}
                      · {whenText(row)}
                    </span>
                  </div>
                </ItemContent>
                <ItemActions className="self-start">
                  <span className="font-medium text-destructive text-sm">
                    {verdict}
                  </span>
                </ItemActions>
              </Item>
              {index !== changes.length - 1 && <Separator />}
            </div>
          );
        })}
      </PageRows>
      {total > changes.length ? (
        <p className="mt-2 text-muted-foreground text-xs">
          Showing the first {changes.length} of {total}.
        </p>
      ) : null}
    </>
  );
}
