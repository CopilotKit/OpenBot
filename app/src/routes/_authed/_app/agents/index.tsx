import { IconBoxSeam, IconFileImport, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentProfile as AgentProfileDetail } from "@/components/agents/agent-profile";
import { ImportTemplate } from "@/components/agents/import-template";
import { NewAgent } from "@/components/agents/new-agent";
import { DetailPanel } from "@/components/layout/detail-panel";
import { StaggerItem } from "@/components/layout/stagger";
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
  /**
   * Reading a stranger's file is a place, not a modal.
   *
   * The consent screen is long, it is the only thing standing between somebody else's prose and a
   * model, and a person will leave it half-read to go and look at what they already have. A search
   * parameter survives that: the roster stays mounted behind it, Back closes it, and the URL can be
   * handed to a colleague who has to decide.
   */
  import: z.boolean().optional(),
  /**
   * A draft of this deployment's own, opened as the file to import.
   *
   * The round trip an author needs before sending a template anywhere: pack a coworker, then read
   * the consent screen the person on the other end will read. It is a draft id rather than a
   * document, so nothing about a template travels through a URL.
   */
  template: z.string().optional(),
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
 */
function AgentsScreen() {
  const {
    new: isCreating,
    agent: selectedAgentId,
    import: isImporting,
    template: templateId,
  } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: agents } = useQuery(agentListQueryOptions());
  const mine = agents?.filter((a) => a.mine);
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = isCreating === true;
  const showImport = !showCreate && isImporting === true;
  const showProfile =
    !showCreate && !showImport && selectedAgentId !== undefined;
  const close = () => navigate({ search: {} });

  return (
    <DetailPanel
      onClose={close}
      open={showCreate || showImport || showProfile}
      /*
       * Wider for the import only. The consent screen renders a stranger's instructions verbatim
       * and unabridged, and prose reflowed into a 400px column is prose people skim — which is the
       * one behaviour this screen exists to discourage.
       */
      detailWidth={showImport ? 560 : undefined}
      detail={
        showCreate ? (
          <NewAgent />
        ) : showImport ? (
          <ImportTemplate {...(templateId ? { templateId } : {})} />
        ) : selectedAgentId ? (
          <AgentProfileDetail agentId={selectedAgentId} />
        ) : null
      }
    >
      <div className="max-w-2xl px-4 w-full mx-auto">
        <div className="mt-12 w-full max-w-2xl">
          <div className="flex flex-row w-full items-center justify-between">
            <h2 className="font-bold text-lg">Your agents</h2>
            <div className="flex flex-row items-center gap-1">
              {/*
               * The gallery, first of the three, because it is the only one of them that answers
               * "what could I have?" — Import assumes a file already in hand and Create assumes a
               * coworker already designed. Somebody arriving with neither has nowhere else to go.
               */}
              <Button
                variant="ghost"
                size="sm"
                render={(props) => <Link to="/agents/gallery" {...props} />}
              >
                <IconBoxSeam />
                Templates
              </Button>
              {/*
               * Beside Create rather than behind a menu, because importing one is the other way a
               * coworker comes to exist here and a person arriving with a file somebody sent them
               * should not have to guess that this is the page for it.
               */}
              <Button
                variant="ghost"
                size="sm"
                render={(props) => (
                  <Link to="/agents" search={{ import: true }} {...props} />
                )}
              >
                <IconFileImport />
                Import
              </Button>
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
          </div>
          <div className="flex flex-row mt-4">
            {!!mine?.length && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-4">
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
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-4">
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
