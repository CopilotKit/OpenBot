import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  issueBotAgentCallbackTokenMutationOptions,
  revokeBotAgentCallbackTokenMutationOptions,
} from "@/lib/bot-agents/mutations";
import type { AgentRecord } from "@/lib/bot-agents/queries";
import { queryClient } from "@/query-client";

/**
 * The key an agent at its own address presents when it calls a tool back, as the Bot's own key panel
 * offers it (components/agents/callback-token-panel.tsx).
 *
 * Shown once, and said plainly: OpenBot keeps only a hash, so nothing can show it again. A call made
 * with it is allowed only for a run of a Bot that may use this agent, as the person that run is for.
 */
export function AgentCallbackToken({ agent }: { agent: AgentRecord }) {
  const issue = useMutation(
    issueBotAgentCallbackTokenMutationOptions(queryClient),
  );
  const revoke = useMutation(
    revokeBotAgentCallbackTokenMutationOptions(queryClient),
  );
  /** Held in state, not in a query cache: it must not survive a refetch or a navigation. */
  const [token, setToken] = useState<string | null>(null);
  const error = issue.error ?? revoke.error;

  return (
    <div className="grid w-full gap-2">
      <p className="text-muted-foreground text-sm">
        {agent.hasCallbackToken
          ? "This agent has a key, so it can use the apps of the Bots that hand it work. If you make a new key, the old one stops working right away."
          : "This agent has no key yet. It can answer but can't use apps. Generate a key and add it to your agent's configuration."}
      </p>
      {token ? (
        <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
          <p className="font-medium text-sm">
            Copy this key now. You won't see it again.
          </p>
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
            onClick={async () => setToken(await issue.mutateAsync(agent.id))}
            size="sm"
            variant="outline"
          >
            {issue.isPending
              ? "Generating…"
              : agent.hasCallbackToken
                ? "Make a new key"
                : "Generate key"}
          </Button>
          {agent.hasCallbackToken ? (
            <Button
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(agent.id)}
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
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
