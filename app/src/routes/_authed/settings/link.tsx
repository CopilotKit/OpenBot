import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { confirmLinkState } from "@/lib/identity/link-state";
import { confirmChallengeMutationOptions } from "@/lib/identity/mutations";
import { challengeQueryOptions } from "@/lib/identity/queries";

/**
 * The browser half of a link a person started from a chat app.
 *
 * Confirming here proves which OpenBot user is asking; the link exists only once they finish from
 * the outside account too. Nothing happens on load: opening the page is not consent.
 */
export const Route = createFileRoute("/_authed/settings/link")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === "string" ? { token: search.token } : {},
});

function RouteComponent() {
  const { token } = Route.useSearch();
  const valid = !!token && /^[A-Za-z0-9_-]{43}$/.test(token);
  const peek = useQuery({
    ...challengeQueryOptions(token ?? ""),
    enabled: valid,
  });
  const confirm = useMutation(confirmChallengeMutationOptions());
  const state = confirmLinkState({
    token,
    peek: { status: peek.status, data: peek.data },
    confirm: { status: confirm.status, hint: confirm.data?.hint },
  });

  return (
    <PageShell
      title="Link an account"
      description="Confirm an account you are linking from a chat app."
    >
      <PageSection>
        {state.kind === "invalid" && (
          <p className="text-muted-foreground text-sm">
            This link is not valid.
          </p>
        )}
        {state.kind === "expired" && (
          <p className="text-destructive text-sm" role="alert">
            This link expired or was already used. Ask for a new one.
          </p>
        )}
        {(state.kind === "ready" || state.kind === "confirming") && (
          <>
            <p className="text-muted-foreground text-sm">
              Only confirm if you asked for this link from your own{" "}
              {state.title} account. You will then finish from {state.title}.
            </p>
            <Button
              size="sm"
              disabled={state.kind === "confirming"}
              onClick={() => token && confirm.mutate(token)}
            >
              Confirm it is me
            </Button>
          </>
        )}
        {state.kind === "failed" && (
          <p className="text-destructive text-sm" role="alert">
            This link expired, was already used, or was confirmed by a different
            account. Ask for a new one.
          </p>
        )}
        {state.kind === "done" && (
          <>
            <p className="text-muted-foreground text-sm">
              Confirmed. The link is not active until you finish from{" "}
              {state.title ?? "the app you started from"}.
            </p>
            {state.hint && (
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs">
                {state.hint}
              </pre>
            )}
          </>
        )}
      </PageSection>
    </PageShell>
  );
}
