import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { appConfig } from "@/lib/generated/application-config";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");
  const { start, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);

  /** Default recipient when the composer draft has no mention. */
  const fallback = explore?.[0] ?? agents?.[0];

  return (
    <div className="flex-1 flex flex-col items-center justify-center w-full p-4 mt-8">
      <div className="flex flex-col items-center">
        <h2 className="text-sm uppercase text-muted-foreground font-medium tracking-tight text-center">
          {appConfig.brand.productName}
        </h2>
        <h1 className="text-2xl font-bold tracking-tight mt-1.5 text-center">
          Start a new channel
        </h1>
      </div>
      <div className="mt-8 w-full flex flex-col items-center">
        <Composer
          agents={toAgentOptions(agents)}
          className="w-full max-w-2xl"
          disabled={!fallback}
          onSubmit={async (draft) => {
            // A channel is pinned to one teammate for the life of its thread.
            const agentId = draft.agentId ?? fallback?.id;
            if (!agentId) return;

            setError(null);
            try {
              await start(agentId, draft.text);
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not start the conversation.",
              );
              throw caught;
            }
          }}
          pending={pending}
        />
        {fallback ? (
          // Said out loud: a message that silently reaches somebody you did not choose is the
          // kind of surprise that costs trust the first time it happens.
          <p className="mt-2 w-full max-w-2xl text-xs text-muted-foreground text-center">
            Goes to {fallback.name}. Type <code>@</code> to reach somebody else.
          </p>
        ) : null}
        {error ? (
          <p
            className="mt-2 w-full max-w-2xl text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-10 w-full max-w-2xl">
        <h2 className="font-bold text-lg">Explore agents</h2>
        <div className="flex flex-row gap-4 mt-4">
          {!!explore?.length &&
            explore.map((agent) => (
              <Link
                key={agent.id}
                to="/channel/new"
                search={{
                  agent: agent.id,
                }}
              >
                <AgentCard agent={agent} />
              </Link>
            ))}
        </div>
      </div>
    </div>
  );
}
