import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { PageShell } from "@/components/layout/page-shell";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";

/**
 * The frame of every `/bots/$agentId/<area>` page: back to the Bot by name, then the area.
 *
 * One frame so each area page is only its own rows, and so a Bot the person cannot reach says so in
 * the same words everywhere.
 */
export function BotSubpage({
  agentId,
  title,
  description,
  action,
  children,
}: {
  agentId: string;
  title: string;
  description: string;
  /** The area's one primary verb, on the title's baseline. */
  action?: React.ReactNode;
  children: (agent: AgentProfile) => React.ReactNode;
}) {
  const agent = useQuery(agentQueryOptions(agentId));
  return (
    <PageShell
      action={action}
      backButton={{
        label: agent.data?.name ?? "Bot",
        linkProps: { params: { agentId }, to: "/bots/$agentId" },
      }}
      description={description}
      title={title}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          Couldn't open this Bot. It may not be shared with you.
        </p>
      ) : (
        children(agent.data)
      )}
    </PageShell>
  );
}
