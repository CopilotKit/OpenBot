import { IconChevronDown, IconPlus } from "@tabler/icons-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";

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

// Two equal columns let cards fill the available width at a consistent height.
function AgentsScreen() {
  const { new: isCreating, agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  /*
   * The two empty states below must not fire while the list is still arriving. `skills.tsx` learned
   * this first: an empty state standing there saying somebody has created nothing is a claim the
   * screen has not yet earned, and on a slow connection it is the first thing they read.
   *
   * `isPending` rather than `agents === undefined`, and the difference is the whole point on a
   * screen whose job is to say when there is nothing. `data` is also undefined when the query
   * FAILED, so deriving the flag from it holds the screen in its loading branch forever on an
   * error — two headings over nothing, which is the exact shape this task exists to remove.
   * `isPending` goes false either way, so a failure falls through to the empty state.
   */
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const mine = agents?.filter((a) => a.mine);
  const explore = agents?.filter(isSharedWithYou);
  /*
   * Hiding takes a coworker off both lists above, and Unhide lives in its dialog, which only a card
   * opens. Without this section a hidden coworker had no way back onto the screen short of typing
   * its id into the address bar. Nothing while loading, failed or empty: it is a way back for
   * somebody who hid something, not a third roster everybody has to read past.
   */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));

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
          {loading ? (
            // Approximate one row of cards while the roster loads.
            <Skeleton className="mt-4 h-[180px]" />
          ) : mine?.length ? (
            // Wins over `failed`: TanStack Query keeps the last good `data` across a failed
            // background refetch (see query-core's error action — it spreads `...state` and
            // never clears `data`), so `isError` and a still-populated roster are an ordinary
            // combination, not a contradiction. A stale roster beats an error card claiming
            // there is nothing, which would be false here.
            <div className="mt-4 grid grid-cols-2 gap-4">
              {mine.map((agent, index) => {
                return (
                  <StaggerItem className="min-w-0" index={index} key={agent.id}>
                    <AgentCard agent={agent} />
                  </StaggerItem>
                );
              })}
            </div>
          ) : failed && agents === undefined ? (
            // `agents === undefined` narrows this to "the query has never once returned
            // successfully" — not merely "the last request errored". `?.length` alone can't
            // tell that apart from a slice that loaded and is genuinely empty: TanStack Query
            // never clears `data` on a failed background refetch, so once the query has
            // resolved even one response, `agents` stays defined and `mine`'s emptiness is a
            // fact about that response, not a symptom of the failure. Rendering the destructive
            // card there would say the opposite of what "Explore agents" beside it (or this
            // section itself, on a different roster) proves by rendering real cards from the
            // same query.
            <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
              <EmptyHeader>
                <EmptyTitle className="text-destructive">
                  Your agents couldn't be loaded.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            // Reached both when the query never failed and `mine` is genuinely empty, and when
            // it failed but `agents` is defined — a loaded, empty slice either way. Same plain
            // copy for both: an empty roster is a fact, not an error.
            <Empty className="mt-4 h-[180px] border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  You don't have any agents created.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <div className="mt-8 w-full max-w-2xl">
          <h2 className="font-bold text-lg">Explore agents</h2>
          {loading ? (
            // Approximate one row of cards while the roster loads.
            <Skeleton className="mt-4 h-[180px]" />
          ) : explore?.length ? (
            // Wins over `failed` for the same reason the "Your agents" section above does: a
            // failed background refetch does not clear TanStack Query's cached `data`.
            <div className="mt-4 grid grid-cols-2 gap-4">
              {explore.map((agent, index) => {
                return (
                  <StaggerItem className="min-w-0" index={index} key={agent.id}>
                    <AgentCard agent={agent} />
                  </StaggerItem>
                );
              })}
            </div>
          ) : failed && agents === undefined ? (
            // `agents === undefined` narrows this to "the query has never once returned
            // successfully" — not merely "the last request errored". `?.length` alone can't
            // tell that apart from a slice that loaded and is genuinely empty: TanStack Query
            // never clears `data` on a failed background refetch, so once the query has
            // resolved even one response, `agents` stays defined and `explore`'s emptiness is a
            // fact about that response, not a symptom of the failure. Rendering the destructive
            // card there would say the opposite of what "Your agents" beside it (or this
            // section itself, on a different roster) proves by rendering real cards from the
            // same query.
            <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
              <EmptyHeader>
                <EmptyTitle className="text-destructive">
                  Agents shared with you couldn't be loaded.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            // Reached both when the query never failed and `explore` is genuinely empty, and
            // when it failed but `agents` is defined — a loaded, empty slice either way. Same
            // plain copy for both: an empty roster is a fact, not an error.
            <Empty className="mt-4 h-[180px] border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  Nobody has shared an agent with you yet.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        {hiddenAgents?.length ? (
          <details className="group mt-8 mb-12 w-full max-w-2xl">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <h2 className="font-bold text-lg">Hidden</h2>
              <span className="text-sm text-muted-foreground">
                {hiddenAgents.length}
              </span>
              <IconChevronDown
                aria-hidden="true"
                className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {hiddenAgents.map((agent) => (
                <div className="min-w-0" key={agent.id}>
                  <AgentCard agent={agent} />
                </div>
              ))}
            </div>
          </details>
        ) : null}
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
