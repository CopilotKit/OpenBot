import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Creating and inspecting a coworker are search-parameter states so the roster remains mounted and
 * Back closes the dialog.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: AgentsScreen,
});

/*
 * The roster wraps on the width it actually has, not on the window's.
 *
 * A card is a fixed 144px, so four fixed columns overlap the moment the column they sit in is
 * narrower than the card. That is not a narrow-window case: opening the detail pane takes the width
 * out of this column at any window size, so the cards behind an open Bot overlapped each other on a
 * perfectly ordinary screen. `auto-fill` tracks the container instead, which is the thing that
 * actually changed.
 *
 * The tracks are the card's own width, not `minmax(144px,1fr)`. A `1fr` track stretches to share
 * the container while the card inside it stays 144px, and the difference reads as a gap: at prose
 * width that was three 190px columns holding 144px cards, so the 15px gutter looked like 61px. The
 * home screen's Explore row is the reference — fixed cards, `gap-4`, nothing stretching.
 */
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
    <>
      <SidebarToggleBar />
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
              <div className="grid grid-cols-[repeat(auto-fill,144px)] gap-4">
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
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,144px)] gap-4">
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
      <CreateAgentDialog
        onClose={close}
        onCreated={(agentId) => navigate({ search: { agent: agentId } })}
        open={showCreate}
      />
      <AgentDialog
        agentId={selectedAgentId ?? null}
        onClose={close}
        open={showProfile}
      />
    </>
  );
}
