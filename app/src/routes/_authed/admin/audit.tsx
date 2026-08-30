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
import { silenceOf } from "@/lib/audit/silence";

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
    /*
     * Include every refusal family, not only browser policy refusals.
     *
     * `mcp.callback_refused` is here because it is a refusal, even though nothing about a Bot was
     * judged: a caller could not prove which Bot it was. Somebody filtering for what this deployment
     * turned away wants that in the list, and it is the one refusal with no policy behind it, so
     * leaving it out would hide the only evidence that anything was attempted.
     *
     * `routines.dispatch_refused` is the same shape one boundary over: the worker, not a Bot, and a
     * stale or missing secret rather than a policy decision. The same reasoning that put
     * `mcp.callback_refused` here applies unchanged — nobody was judged, something was still turned
     * away, and the saved view a person clicks for "what did this deployment block" should show it.
     *
     * `template.import_refused` is the same question asked of a document. It belongs here more than
     * any of the others do: a refused import leaves nothing behind anywhere else in the product —
     * no Bot, no skill, no ledger row — so this is the only view in which the attempt can be
     * counted at all, and counting is the point. One refused paste is somebody's typo. Forty in an
     * afternoon, each turned away for a different reason, is somebody mapping the edges of the
     * parser, and that is only ever visible to a reader who can list them together.
     *
     * `template.capability_declined` is an administrator turning an ask down, which is a refusal by
     * a person rather than by a rule. `template.capability_requested` is deliberately NOT here:
     * nothing was forbidden, the ask simply landed unmet, and padding this filter with the designed
     * outcome would teach a reader to discount the refusals that are real.
     */
    search:
      "?eventType=computer.action_refused,mcp.call_rejected,mcp.callback_refused,component.refused,component.function_refused,routines.dispatch_refused,template.import_refused,template.capability_declined",
  },
  {
    label: "Did not happen",
    // A stalled stream belongs here. It is the same complaint as an action that was allowed and then
    // did not take: nothing was refused, and nothing came of it either.
    search: "?eventType=computer.action_failed,agent.stream_stalled",
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

        {events.isPending ? null : events.isError ? (
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
    carriedOut?: boolean;
  };
  const element = payload.element as
    | { role?: string; name?: string }
    | string
    | undefined;
  const refused =
    event.eventType === "computer.action_refused" ||
    event.eventType === "component.refused" ||
    event.eventType === "component.function_refused" ||
    event.eventType === "mcp.call_rejected" ||
    /*
     * A caller that could not prove which Bot it was. Refused like the others, and it has to read
     * that way here: the fallback below calls anything it does not recognise "Allowed", which for a
     * refusal is the one wrong answer. A trail that is confidently wrong is worse than a silent one.
     */
    event.eventType === "mcp.callback_refused" ||
    // The worker turned away at the door, same reasoning as the caller above.
    event.eventType === "routines.dispatch_refused" ||
    /*
     * A document this deployment would not take, and an ask an administrator turned down.
     *
     * These two arrived with the template family and this predicate was not told about them, so
     * they took the fallback: `template.import_refused` painted the word "Allowed" in the muted
     * foreground on the one row an investigator opens this page to find. A person turning away
     * forty pasted files in an afternoon read forty rows saying the deployment had allowed them.
     *
     * `template.capability_requested` is not here on purpose. Nothing was forbidden — configuration
     * travels and capability does not, so an ask that lands unmet is the designed behaviour — and
     * colouring it as a refusal would devalue the refusals that are real.
     */
    event.eventType === "template.import_refused" ||
    event.eventType === "template.capability_declined";
  const stalled = event.eventType === "agent.stream_stalled";
  const templateSubject = templateSubjectOf(event, payload);
  /*
   * Three different things, and the difference is what somebody comes to this row to find out.
   *
   * A person naming a coworker, the router matching one, and the router giving up and using the
   * default are not the same event, and one label covering all three would make the row worth less
   * than the reason line under it. Nothing here is a refusal, so none of them take the refusal
   * colour.
   */
  const routed =
    event.eventType === "channel.routed"
      ? payload.viaMention === true
        ? "The person chose this coworker"
        : payload.fallback === true
          ? "Sent to the default coworker"
          : "Sent to the coworker it is for"
      : null;
  // Allowed by policy but not carried out. A stalled turn belongs in the same family: the Bot was
  // asked and the answer never arrived. Colour is how this table is read, and a row left in the
  // muted foreground reads as "Allowed", which a turn nobody ever got an answer to was not.
  const failed = event.eventType === "computer.action_failed" || stalled;
  const silence = stalled ? silenceOf(payload) : null;

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
        {/*
         * A routing row's subject is the coworker it went to, and it is the only thing on the row
         * worth reading. Its target type is `agent`, which is not a named target because everywhere
         * else an agent id appears it belongs in the Bot column; here nothing acted, so there is no
         * Bot and the target is all there is. Rendered through `nameFor` so it reads as the name on
         * the roster rather than the immutable id.
         */}
        {event.eventType === "channel.routed" && event.targetId ? (
          <span title={event.targetId}>{nameFor(event.targetId)}</span>
        ) : templateSubject ? (
          <span
            className="font-mono text-xs"
            title={
              typeof payload.digest === "string" ? payload.digest : undefined
            }
          >
            {templateSubject}
          </span>
        ) : /*
         * A discovery row's subject is the narrowing itself, so the numbers are the subject. A
         * reader asking "why did it not call the tool" needs to see that eleven of thirty were
         * offered before anything else on the row means anything.
         */
        event.eventType === "mcp.tools_discovered" ? (
          <span className="font-mono text-xs">
            {typeof payload.offered === "number" &&
            typeof payload.granted === "number"
              ? `${payload.offered} of ${payload.granted} tools`
              : "-"}
          </span>
        ) : /* Named targets and file paths are the audit subject before page elements. */
        NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span className="font-mono text-xs">
            {event.targetId}
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · {payload.function}
              </span>
            ) : null}
          </span>
        ) : typeof payload.file === "string" ? (
          <span className="font-mono text-xs">{payload.file}</span>
        ) : typeof payload.command === "string" ? (
          // The command is the subject of its own row, the way a path is for a file action.
          <span className="font-mono text-xs">{payload.command}</span>
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
        typeof payload.command !== "string" &&
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
          {routed ??
            DECISIONS[event.eventType] ??
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
        {/*
         * Why this run was offered what it was, which is the only part of a discovery row that
         * cannot be worked out from the numbers. "Nothing declared" and "selector unavailable" both
         * offer everything and mean entirely different things about the deployment.
         */}
        {event.eventType === "mcp.tools_discovered" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {DISCOVERY_REASONS[payload.reason] ?? payload.reason}
            {Array.isArray(payload.skills) && payload.skills.length > 0
              ? `: ${payload.skills.join(", ")}`
              : ""}
          </div>
        ) : null}
        {/*
         * Why a document was turned away, in the server's own code rather than in the sentence the
         * person who pasted it read.
         *
         * The code is the half that was written to be counted — `templates/routes.ts` records it
         * instead of the message so rows can be grouped — and grouping is the whole reason a reader
         * comes to this page rather than reading one refusal at a time. Left off the row entirely,
         * as it was, forty refusals looked identical and the fact that they were forty DIFFERENT
         * refusals was unrecoverable.
         *
         * Not translated into prose here. The codes are declared on the server, they grow with the
         * parser, and a lookup table kept in this file would go stale silently and print nothing at
         * all for a code it had not heard of — which is worse than a slug a reader can read.
         */}
        {event.eventType === "template.import_refused" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {payload.reason}
            {typeof payload.field === "string" ? ` · ${payload.field}` : ""}
          </div>
        ) : null}
        {event.eventType === "mcp.callback_refused" &&
        typeof payload.refusal === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.refusal}
          </div>
        ) : null}
        {/*
         * Why the conversation went where it went, which is the whole reason the row is written.
         * Without it a routing row says "Allowed" and names nobody, which is indistinguishable from
         * a row that failed to write.
         */}
        {event.eventType === "channel.routed" &&
        typeof payload.reason === "string" ? (
          /*
           * A width rather than a max-width, because the table lays itself out from its content and
           * a max-width on a block inside a cell does not constrain that. A router's reason is a
           * sentence a model wrote, not a rule name, and left unbounded in the last column it
           * pushes the table wider than the page and the end of the sentence goes off the edge,
           * where nobody scrolls to find it.
           */
          <div className="mt-0.5 w-[22rem] break-words text-xs text-muted-foreground">
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
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.failure}
          </div>
        ) : null}
        {/*
         * The two numbers the stall row is worth reading for. Without them every stalled turn looks
         * the same, and the difference between an endpoint that dies halfway through an answer and
         * one that never begins is the difference between a slow Bot and a dead one.
         */}
        {silence ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{silence}</div>
        ) : null}
        {/* Show concrete policy rules, but suppress the uninformative default `true` allow rule. */}
        {decision.rule && decision.rule !== "true" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {decision.rule}
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
/**
 * Why a run was offered the tools it was, in words rather than in the slug the server writes.
 *
 * Every one of these looks the same from outside: the Bot was handed some tools. The distinction is
 * the difference between a deployment that narrowed on purpose, one that has never declared a skill,
 * and one whose selector could not be reached, and only the last is a fault.
 */
const DISCOVERY_REASONS: Record<string, string> = {
  "under-floor": "Few enough tools to offer them all",
  "nothing-declared": "No skill declares any of these tools",
  unavailable: "Could not choose, so all were offered",
  "nothing-chosen": "No skill applied, so all were offered",
  selected: "Chosen by skill",
};

/**
 * What a template row is about, for the column that had nothing to draw for any of them.
 *
 * A template row's target is either an agent id, which this table keeps out of the subject column
 * on purpose, or a bare digest under the target type `template`, which is not a named target. So
 * every row in the family — including the refusals, the rows somebody opens this page to count —
 * showed a dash where the subject goes, and one refused import was indistinguishable from another.
 *
 * The slug is what a person recognises: it is what the file is called and what they typed. The
 * digest goes in the title rather than the cell, because the exact bytes matter to whoever is
 * chasing a specific document and to nobody else, and it is forty characters of hex in a column
 * that has to stay scannable. A refusal that never got far enough to be parsed carries neither, and
 * then the digest alone is all there is; a file refused on its size carries not even that, and a
 * dash is the honest answer.
 *
 * A capability row names the thing that was asked for instead. "Granted" and "declined" are only
 * worth reading beside the connector or component they answer.
 */
function templateSubjectOf(
  event: AuditEvent,
  payload: Record<string, unknown>,
): string | null {
  if (!event.eventType.startsWith("template.")) return null;
  if (typeof payload.kind === "string" && typeof payload.ref === "string") {
    return `${payload.kind}: ${payload.ref}`;
  }
  if (typeof payload.templateSlug === "string") return payload.templateSlug;
  if (typeof payload.slug === "string") return payload.slug;
  if (event.targetType === "template" && event.targetId) return event.targetId;
  return null;
}

const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

const DECISIONS: Record<string, string> = {
  "bot.declined": "The Bot declined",
  // Not a refusal, so not the refusal colour: nothing was blocked. The Bot was asked and never
  // answered, which is the same complaint as an action that was allowed and then did not happen.
  "agent.stream_stalled": "The Bot stopped responding",
  "computer.policy_loaded": "Boundary at start-up",
  "computer.isolation_loaded": "Isolation at start-up",
  "computer.control_taken": "A person took the wheel",
  "computer.control_released": "The wheel was handed back",
  "computer.help_requested": "The Bot asked for help",
  "computer.secret_requested": "The Bot asked for a secret",
  "computer.secret_supplied": "A person supplied a secret",
  "computer.reset": "The computer was reset",
  "computer.stopped": "A person pressed stop",

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

  // Not a call and not a decision: the tools this run was allowed to see. Worded so nobody reads it
  // as permission, which it is not — everything named was already granted.
  "mcp.tools_discovered": "Tools offered for one run",
  "mcp.call_succeeded": "Called on this Bot's behalf",
  "mcp.call_rejected": "Blocked",
  "mcp.call_failed": "The server did not answer",
  // Not "Blocked": nothing about the Bot was judged, because nothing proved which Bot it was.
  "mcp.callback_refused": "Could not prove which Bot it was",

  /*
   * The template family, all nine, because a table that does not know an event type does not fall
   * silent — it says "Allowed".
   *
   * For the two refusals that was a lie, and for the other seven it was an answer to a question
   * nobody asked: an export is not a permission, and a row reading "Allowed" against a coworker's
   * configuration leaving the deployment as a file invites exactly the wrong conclusion about what
   * was allowed to whom. Every one of them says what happened instead.
   */
  "template.exported": "Left here as a file",
  "template.imported": "Installed from somebody's file",
  "template.import_refused": "Refused, and nothing was installed",
  // Not a refusal and not coloured as one. The install succeeded; the ask went unanswered, which is
  // what "configuration travels and capability does not" looks like on a row.
  "template.capability_requested": "Asked for, and not granted here",
  "template.capability_granted": "A person granted this ask",
  "template.capability_declined": "A person declined this ask",
  "template.boundary_applied": "The template's boundary, put on this Bot",
  "template.boundary_removed": "The template's boundary, taken off this Bot",
  "template.retracted": "The import was taken back",

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
