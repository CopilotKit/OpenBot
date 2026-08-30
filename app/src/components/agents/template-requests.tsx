import { useMutation, useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { Button } from "@/components/ui/button";
import { decideTemplateRequestMutationOptions } from "@/lib/templates/mutations";
import {
  type TemplateRequestRecord,
  templateImportQueryOptions,
} from "@/lib/templates/queries";
import { queryClient } from "@/query-client";

/**
 * What an imported coworker asked for and has not been given.
 *
 * A Bot arrives COLD. Its template asked for connectors and components; the import wrote none of
 * them, and warming it up is a series of individually audited authorizations rather than a
 * re-import. This list is the only place that ask is visible after the consent screen has gone, and
 * it is amber because a Bot that silently cannot do its job is indistinguishable from a Bot nobody
 * wanted to work — which is precisely the distinction the ledger exists to keep.
 *
 * It does not claim a capability is in force. `status` records that a person decided; whether a
 * grant is live is answered by the grant tables at read time, which is why a row that has been
 * granted simply leaves this list rather than growing a tick. A second source of truth for a
 * permission is the bug this design was careful not to repeat.
 */
export function TemplateRequests({ agentId }: { agentId: string }) {
  const imported = useQuery(templateImportQueryOptions(agentId));
  const user = useQuery(currentUserQueryOptions());
  const decide = useMutation(decideTemplateRequestMutationOptions(queryClient));

  if (imported.isPending) return null;
  if (imported.error || !imported.data) return null;

  const unmet = imported.data.requests.filter(
    (request) => request.status !== "granted" && request.status !== "declined",
  );
  const declined = imported.data.requests.filter(
    (request) => request.status === "declined",
  );
  if (unmet.length === 0 && declined.length === 0) return null;

  /*
   * A hint for the screen, and nothing more. This is the raw role off `GET /api/me` — the ledger
   * payload carries no `canGrant` the way an agent carries `canManage` — so it is a rule recomputed
   * in the browser and it decides nothing. The refusal that counts is `requireAdmin` on the decide
   * route in `server/src/templates/routes.ts`. The comment that used to sit here claimed this was
   * the server's own flag, which would have stopped an auditor looking for where granting is
   * authorized at exactly the wrong line.
   */
  const isAdmin = user.data?.role === "admin";

  return (
    <section className="mt-6 grid gap-2">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Requested, not granted ({unmet.length})
      </h2>

      <p className="text-muted-foreground text-sm">
        The template that this coworker came from asked for these. Nothing was
        given to it on import, and it works without them or says that it cannot.
      </p>

      {decide.error ? (
        <p className="text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}

      <ul className="grid gap-2">
        {unmet.map((request) => (
          <li
            className="grid gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
            key={`${request.kind}:${request.ref}`}
          >
            <p className="break-all font-mono text-sm">{request.ref}</p>
            {/*
             * The author's sentence, rendered as the text it is. It is a stranger's prose sitting
             * beside a Grant button, so it is never markup and never formatted.
             */}
            <p className="whitespace-pre-wrap text-sm">{request.why}</p>
            <p className="text-muted-foreground text-xs">{reason(request)}</p>
            {isAdmin ? (
              <Decision
                busy={decide.isPending}
                onDecide={(verdict) =>
                  decide.mutate({
                    agentId,
                    kind: request.kind,
                    ref: request.ref,
                    verdict,
                  })
                }
                request={request}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {declined.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {declined.length === 1
            ? "One further ask was declined."
            : `${declined.length} further asks were declined.`}
        </p>
      ) : null}

      {isAdmin ? null : (
        <p className="text-muted-foreground text-xs">
          An administrator decides each of these.
        </p>
      )}
    </section>
  );
}

/**
 * Why this ask is still open, in the deployment's terms rather than the ledger's.
 *
 * The three unmet statuses mean genuinely different things and lead to different next steps: one is
 * waiting for a decision, one is waiting for somebody to connect a vendor, and one is waiting for a
 * build that has the component in it.
 */
function reason(request: TemplateRequestRecord): string {
  if (request.status === "unavailable") {
    return "That connector is not connected on this deployment, so there is nothing yet to grant.";
  }
  if (request.status === "not_in_build") {
    return "There is no component by that name in this build. The Bot reaching for it is told so.";
  }
  return "Waiting for somebody who may to decide it.";
}

/**
 * Grant, or say no and record that somebody did.
 *
 * A bare connector id gets no Grant button. The ask is real — a template named a vendor that lists
 * no tools here — but the answer to it is adding the connector, not writing a grant: a grant for a
 * tool that does not exist is invisible on every screen and would go live the day somebody added
 * that vendor, with nobody having decided anything.
 *
 * Neither does a row the deployment cannot satisfy. `unavailable` means the connector is not
 * connected here and `not_in_build` means no component answers to that name, and the server refuses
 * to grant either — so offering the button was offering an act that could only end in an error
 * message. Declining stays available for both, because recording that somebody said no is a real
 * decision whatever the deployment happens to have installed.
 */
function Decision({
  request,
  onDecide,
  busy,
}: {
  request: TemplateRequestRecord;
  onDecide: (verdict: "grant" | "decline") => void;
  busy: boolean;
}) {
  const grantable =
    request.status === "requested" &&
    (request.kind === "component" ||
      (request.kind === "mcp" && request.ref.includes("/")));

  return (
    <div className="mt-0.5 flex gap-2">
      {grantable ? (
        <Button
          disabled={busy}
          onClick={() => onDecide("grant")}
          size="sm"
          variant="outline"
        >
          Grant
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">{whyNoGrant(request)}</p>
      )}
      <Button
        disabled={busy}
        onClick={() => onDecide("decline")}
        size="sm"
        variant="ghost"
      >
        Decline
      </Button>
    </div>
  );
}

/** What to do instead of granting, for the three rows that have no grant to write. */
function whyNoGrant(request: TemplateRequestRecord): string {
  if (request.status === "unavailable") {
    return "Connect it on the Plugins page first. There is nothing here yet to grant.";
  }
  if (request.status === "not_in_build") {
    return "A build carrying that component is what unblocks this. There is nothing here to grant.";
  }
  return "Add this connector on the Plugins page, then grant the tools this Bot needs.";
}
