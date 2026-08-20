import { IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import { auditEventsQueryOptions } from "@/lib/audit/queries";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});

/** One row as the API returns it. */
type AuditEvent = {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

const FILTERS = [
  { label: "Everything", search: "" },
  { label: "Computer actions", search: "?eventType=computer.action_allowed" },
  {
    label: "Blocked",
    // Include every refusal family, not only browser policy refusals. A person declining a request
    // stopped an action just as surely as a deny rule did, and it leaves no action row of its own,
    // so without it here the trail's answer to "was anything blocked" is missing a whole family.
    search:
      "?eventType=computer.action_refused,approval.denied,mcp.call_rejected,component.refused,component.function_refused",
  },
  { label: "Did not happen", search: "?eventType=computer.action_failed" },
  {
    /*
     * The questions, so the one a person never answered can be found rather than looked for by eye.
     * A request with no answer beside it is the Bot having sat waiting while nobody was watching the
     * screen, which is the case this trail records that nothing else in the product would show.
     */
    label: "Asked a person",
    search: "?eventType=approval.requested,approval.granted,approval.denied",
  },
  {
    // Its own filter rather than a place in "Blocked". A Bot repeating itself has not been stopped by
    // anything, and putting it beside the refusals would make the refusals look less real.
    label: "Going in circles",
    search: "?eventType=computer.action_repeated",
  },
] as const;

function AuditPage() {
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const events = useQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.events ?? []) as AuditEvent[];
  const nameFor = useBotNames();

  return (
    /*
     * THE ONE WIDE PAGE IN ADMIN, and the one that keeps a table. Five columns of short values is
     * what a log is; rows of prose would make every entry a paragraph and the scanning this page
     * exists for impossible. It takes the same header and the same type scale as everything else,
     * and differs only where the content forces it to.
     */
    <PageShell
      action={
        <Button onClick={() => events.refetch()} size="sm" variant="ghost">
          <IconRefresh />
          Refresh
        </Button>
      }
      description="Every action a Bot took, and every one this deployment's policy refused."
      title="Audit"
      width="wide"
    >
      <PageSection>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter.label}
              onClick={() => setSearch(filter.search)}
              size="sm"
              type="button"
              /* The fill is the state, as on every other set of switches in the app. */
              variant={search === filter.search ? "default" : "outline"}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {events.isPending ? (
          <PageEmpty>Loading the trail…</PageEmpty>
        ) : events.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            The audit trail could not be loaded.
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>No events match this filter yet.</PageEmpty>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr className="border-border border-b">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">What</th>
                  <th className="px-4 py-2 font-medium">On</th>
                  <th className="px-4 py-2 font-medium">Bot</th>
                  <th className="px-4 py-2 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <Row event={event} key={event.id} nameFor={nameFor} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function Row({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    approvedBy?: string;
    carriedOut?: boolean;
  };
  const element = payload.element as
    | { role?: string; name?: string }
    | string
    | undefined;
  const refused =
    event.eventType === "computer.action_refused" ||
    event.eventType === "approval.denied" ||
    event.eventType === "component.refused" ||
    event.eventType === "component.function_refused" ||
    event.eventType === "mcp.call_rejected";
  // The three rows a question leaves behind carry their rule at the top level rather than under a
  // decision, because no decision was reached: the policy stopped and waited for a person.
  const approval = event.eventType.startsWith("approval.");
  // Allowed by policy but not carried out.
  const failed = event.eventType === "computer.action_failed";

  return (
    <tr className="border-border border-t align-top">
      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
        {new Date(event.createdAt).toLocaleTimeString()}
      </td>
      <td className="px-4 py-2 font-medium">
        {/* Strip the internal computer tool namespace for display. */}
        {typeof payload.action === "string"
          ? payload.action.replace("computer_", "")
          : event.eventType}
      </td>
      <td className="px-4 py-2">
        {/* Named targets and file paths are the audit subject before page elements. */}
        {NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span className="font-mono text-xs">
            {event.targetId}
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · {payload.function}
              </span>
            ) : null}
          </span>
        ) : typeof payload.fingerprint === "string" ? (
          // A repeat row has no element and no file of its own: what it is about is the call, which
          // the fingerprint names in full.
          <span className="font-mono text-xs">{payload.fingerprint}</span>
        ) : typeof payload.file === "string" ? (
          <span className="font-mono text-xs">{payload.file}</span>
        ) : typeof element === "object" && element?.name ? (
          <span>
            {element.name}
            {element.role ? (
              <span className="text-muted-foreground"> ({element.role})</span>
            ) : null}
          </span>
        ) : typeof element === "string" ? (
          <span className="text-muted-foreground">{element}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
        {/* Page host is meaningful only for browser actions, not workspace file actions. */}
        {typeof payload.file !== "string" &&
        typeof payload.page === "string" &&
        payload.page ? (
          <div className="text-xs text-muted-foreground">
            {hostOf(payload.page)}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        {typeof payload.bot === "string" ? (
          // Keep the immutable bot id available even when names collide.
          <span title={payload.bot}>{nameFor(payload.bot)}</span>
        ) : (
          "-"
        )}
      </td>
      <td className="px-4 py-2">
        <span
          className={
            refused
              ? "font-medium text-destructive"
              : failed
                ? "font-medium text-amber-600 dark:text-amber-500"
                : "text-muted-foreground"
          }
        >
          {DECISIONS[event.eventType] ??
            (refused ? "Blocked" : failed ? "Did not happen" : "Allowed")}
        </span>
        {/* Refusal reasons mirror the conversation-facing reason. */}
        {(event.eventType === "component.refused" ||
          event.eventType === "component.function_refused" ||
          event.eventType === "mcp.call_rejected") &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {event.eventType === "bot.declined" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
            <span className="italic">, reported by the Bot itself</span>
          </div>
        ) : null}
        {event.eventType === "computer.action_repeated" &&
        typeof payload.count === "number" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.count} times within a few minutes
          </div>
        ) : null}
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.failure}
          </div>
        ) : null}
        {approval && typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {/* Show concrete policy rules, but suppress the uninformative default `true` allow rule. */}
        {decision.rule && decision.rule !== "true" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {decision.rule}
          </div>
        ) : null}
        {approval && typeof payload.rule === "string" && payload.rule ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {payload.rule}
          </div>
        ) : null}
        {/* Who stood behind an action, when the boundary asked and somebody said yes. */}
        {typeof decision.approvedBy === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            allowed by {decision.approvedBy}
          </div>
        ) : null}
        {decision.mode === "dry-run" && decision.carriedOut ? (
          <div className="text-xs text-muted-foreground">
            dry-run: recorded, not enforced
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Target types whose id is a name worth putting on screen.
 *
 * Anything else falls through to the element or file subject.
 */
const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

const DECISIONS: Record<string, string> = {
  "bot.declined": "The Bot declined",
  "computer.policy_loaded": "Boundary at start-up",
  "computer.isolation_loaded": "Isolation at start-up",
  "computer.control_taken": "A person took the wheel",
  "computer.control_released": "The wheel was handed back",
  "computer.help_requested": "The Bot asked for help",
  "computer.secret_requested": "The Bot asked for a secret",
  "computer.secret_supplied": "A person supplied a secret",
  "computer.reset": "The computer was reset",
  "computer.stopped": "A person pressed stop",
  // Not "Blocked". Nothing refused this; the Bot did the same thing again and the trail is saying so.
  "computer.action_repeated": "The Bot repeated itself",
  "approval.requested": "The boundary asked a person",
  "approval.granted": "A person allowed it",
  "approval.denied": "A person declined it",

  "component.granted": "Granted to this Bot",
  "component.revoked": "Taken away from this Bot",
  "component.published": "Published, so every Bot may use it",
  "component.unpublished": "Unpublished, so no Bot may use it",
  "component.draft_saved": "Draft saved, not yet published",
  "component.refused": "Refused",
  "component.function_granted": "May read this",
  "component.function_revoked": "May no longer read this",
  "component.function_called": "Read real data",
  "component.function_refused": "Refused",
  // A function failure is execution failure, not a policy refusal.
  "component.function_failed": "Could not be read",

  "mcp.call_succeeded": "Called on this Bot's behalf",
  "mcp.call_rejected": "Blocked",
  "mcp.call_failed": "The server did not answer",

  "configuration.changed": "Configuration changed",
  "credential.created": "Credential saved",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
