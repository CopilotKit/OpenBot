import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  issueCallbackTokenMutationOptions,
  revokeCallbackTokenMutationOptions,
} from "@/lib/agents/mutations";
import { failureSaid } from "@/lib/load-failure";

/**
 * The credential this coworker presents when it calls a tool back.
 *
 * Only for a coworker that runs somewhere else. The Bot in the box has no endpoint and nothing to
 * authenticate as, and offering it a token would imply otherwise.
 *
 * Shown once, and said plainly. This deployment keeps a hash, so there is no screen that can show the
 * token again: an operator who loses it rotates, and rotating retires the old one, which is also how a
 * leak is handled.
 *
 * A KEY IS NOT WHAT GIVES A CONNECTED BOT TOOLS. OpenBot offers its tools to every Bot in the run's
 * AG-UI `tools`, and a Bot at an address hands each call back for OpenBot to run, through the same
 * grants, approvals and audit trail. That needs no key. The key is for the other door: an agent that
 * runs its own tool loop and calls OpenBot's tools itself (`AGENT_TOOL_TOKEN` in
 * docs/configuration.md is the same door for the Bots OpenBot starts). The panel used to tell a stock AG-UI Bot with no key that it
 * "can't use tools" right after it had used four of them.
 *
 * A Bot OpenBot runs itself, the harness picked in setup, is handed OpenBot's key on every run and
 * uses its tools with none of its own. The panel says so and offers nothing to generate: it used to
 * tell the personal starter it "can't use tools" while it searched the web and used the browser.
 */
export const KEY_FROM_OPENBOT =
  "OpenBot runs this Bot, so it can use its tools without a key.";

const NO_KEY_NEEDED =
  "This Bot can use OpenBot's tools in its conversations without a key. Generate a key only if your agent calls OpenBot's tools itself.";

const KEY_HELD =
  "This Bot has a key, so your agent can call OpenBot's tools itself. If you make a new key, the old one stops working right away.";

export function CallbackTokenPanel({
  agentId,
  hasToken,
  fromOpenBot = false,
}: {
  agentId: string;
  hasToken: boolean;
  fromOpenBot?: boolean;
}) {
  const queryClient = useQueryClient();
  const issue = useMutation(issueCallbackTokenMutationOptions(queryClient));
  const revoke = useMutation(revokeCallbackTokenMutationOptions(queryClient));

  /** Held in state, not in a query cache: it must not survive a refetch or a navigation. */
  const [token, setToken] = useState<string | null>(null);
  const error = issue.error ?? revoke.error;

  const heading = (
    <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Key for tools
    </h2>
  );

  if (fromOpenBot) {
    return (
      <section className="mt-6 grid gap-2">
        {heading}
        <p className="text-muted-foreground text-sm">{KEY_FROM_OPENBOT}</p>
      </section>
    );
  }

  return (
    <section className="mt-6 grid gap-2">
      {heading}

      <p className="text-muted-foreground text-sm">
        {hasToken ? KEY_HELD : NO_KEY_NEEDED}
      </p>

      {token ? (
        <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
          <p className="font-medium text-sm">
            Copy this key now. You won't see it again.
          </p>
          {/*
           * Selectable and wrapped rather than a copy button alone: somebody pasting this into a
           * deployment config on another machine may not have a clipboard between the two.
           */}
          <code className="block break-all rounded bg-foreground/5 p-2 font-mono text-xs">
            {token}
          </code>
          <p className="text-muted-foreground text-xs">
            If you lose it, make a new one.
          </p>
          <Button onClick={() => setToken(null)} size="sm" variant="outline">
            Done
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={issue.isPending}
            onClick={async () => setToken(await issue.mutateAsync(agentId))}
            size="sm"
            variant="outline"
          >
            {issue.isPending
              ? "Generating…"
              : hasToken
                ? "Make a new key"
                : "Generate key"}
          </Button>
          {hasToken ? (
            <Button
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(agentId)}
              size="sm"
              variant="outline"
            >
              {revoke.isPending ? "Revoking…" : "Revoke key"}
            </Button>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {failureSaid(error)}
        </p>
      ) : null}
    </section>
  );
}
