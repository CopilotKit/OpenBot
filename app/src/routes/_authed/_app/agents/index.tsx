import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { StaggerItem } from "@/components/layout/stagger";
import { AgentProfile as AgentProfileDetail } from "@/components/agents/agent-profile";
import { NewAgent } from "@/components/agents/new-agent";
import { DetailPanel } from "@/components/layout/detail-panel";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Creating and inspecting a coworker are search-parameter states so the roster remains mounted and
 * Back closes the detail pane.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: AgentsScreen,
});

function AgentsScreen() {
  const { new: isCreating, agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: agents } = useQuery(agentListQueryOptions());
  const mine = agents?.filter((a) => a.mine);
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = isCreating === true;
  const showProfile = !showCreate && selectedAgentId !== undefined;
  const close = () => navigate({ search: {} });

  return (
    <DetailPanel
      onClose={close}
      open={showCreate || showProfile}
      detail={
        showCreate ? (
          <NewAgent />
        ) : selectedAgentId ? (
          <AgentProfileDetail agentId={selectedAgentId} />
        ) : null
      }
    >
      <div className="max-w-2xl px-4 w-full mx-auto">
        <div className="mt-12 w-full max-w-2xl">
          <div className="flex flex-row w-full items-center justify-between">
            <h2 className="font-bold text-lg">Your agents</h2>
            <Button
              variant="ghost"
              size="sm"
              render={(props) => (
                <Link to="/agents" search={{ new: true }} {...props} />
              )}
            >
              <IconPlus />
              New agent
            </Button>
          </div>
          <div className="flex flex-row mt-4">
            {!!mine?.length && (
              <div className="grid grid-cols-4 gap-4">
                {mine.map((agent, index) => {
                  return (
                    <StaggerItem index={index} key={agent.id}>
                      <Link to="/agents" search={{ agent: agent.id }}>
                        <AgentCard agent={agent} />
                      </Link>
                    </StaggerItem>
                  );
                })}
              </div>
            )}
            {!mine?.length && (
              <Empty className="border border-dashed h-[180px]">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    You don't have any agents created.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
        <div className="mt-8 w-full max-w-2xl">
          <h2 className="font-bold text-lg">Explore agents</h2>
          <div className="grid grid-cols-4 gap-4 mt-4">
            {!!explore?.length &&
              explore.map((agent, index) => {
                return (
                  <StaggerItem index={index} key={agent.id}>
                    <Link to="/agents" search={{ agent: agent.id }}>
                      <AgentCard agent={agent} />
                    </Link>
                  </StaggerItem>
                );
              })}
          </div>
        </div>
      </div>
    </DetailPanel>
  );
}
