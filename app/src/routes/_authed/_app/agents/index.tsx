import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AgentList } from "@/components/bot-agents/agent-list";
import { AgentSheet } from "@/components/bot-agents/agent-sheet";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  isLegacyAgentsLink,
  legacyAgentsTarget,
} from "@/lib/agents/legacy-routes";
import { botAgentListQueryOptions } from "@/lib/bot-agents/queries";

/**
 * The agents Bots hand work to. `/agents?new` and `/agents?agent=<id>` were the coworker screen's
 * links, and still lead to New Bot and to that Bot's page. Adding and changing an agent are search
 * parameters, so the list stays mounted behind the sheet and Back closes it.
 */
export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    agent: z.string().optional(),
    add: z.boolean().optional(),
    edit: z.string().optional(),
  }),
  beforeLoad: ({ search }) => {
    if (isLegacyAgentsLink(search)) throw redirect(legacyAgentsTarget(search));
  },
  component: AgentsPage,
});

function AgentsPage() {
  const { add, edit } = Route.useSearch();
  const navigate = Route.useNavigate();
  const agents = useQuery(botAgentListQueryOptions());
  const editing = edit
    ? agents.data?.find((agent) => agent.id === edit)
    : undefined;
  const close = () => void navigate({ search: {} });
  return (
    <PageShell
      action={
        <Button
          onClick={() => void navigate({ search: { add: true } })}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          Add agent
        </Button>
      }
      description="Your Bots hand work to these agents. Each one works with the apps of the Bot that sends it, as the person who asked."
      title="Agents"
    >
      <AgentList
        onAdd={() => void navigate({ search: { add: true } })}
        onEdit={(agent) => void navigate({ search: { edit: agent.id } })}
      />
      <AgentSheet onClose={close} open={add === true} />
      {/* Keyed by the agent, so opening another starts from its own fields. */}
      <AgentSheet
        editing={editing}
        key={editing?.id ?? "none"}
        onClose={close}
        open={editing !== undefined}
      />
    </PageShell>
  );
}
