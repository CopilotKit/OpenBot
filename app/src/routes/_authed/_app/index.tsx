import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { appConfig } from "@/lib/generated/application-config";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const explore = agents?.filter(isSharedWithYou);
  const { start, startChosen, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);

  /** Default recipient when the composer draft has no mention. */
  const fallback = defaultAgentProfile(agents, explore?.[0]);

  return (
    <>
      <SidebarToggleBar />
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
              // A channel is pinned to one coworker for the life of its thread, so the coworker is
              // chosen now, before it is created. An `@` is an explicit choice and is honoured as-is.
              // With no `@`, the message is routed to the coworker it is for; if that routing cannot
              // run, it falls back to the same default the composer used to always use.
              setError(null);
              try {
                if (draft.agentId) {
                  // Recorded and started as one sequence, shared with `/channel/new`: the person
                  // already decided, and the trail has to say so wherever they decided it.
                  await startChosen(draft.agentId, draft.text);
                  return;
                }
                let agentId: string | undefined;
                try {
                  agentId = (await routeMessage(draft.text)).agentId;
                } catch {
                  agentId = fallback?.id;
                }
                if (!agentId) return;
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
              Sent to the coworker it is for. Type <code>@</code> to choose one
              yourself.
            </p>
          ) : null}
          {error ? (
            <p
              className="mt-2 w-full max-w-2xl text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : failed && agents === undefined ? (
            // The composer above is `disabled={!fallback}`, and a failed query does not by
            // itself mean `fallback` is undefined: TanStack Query keeps its last good `data`
            // across a failed background refetch, and `!fallback` alone is also true of a query
            // that loaded successfully and genuinely returned zero agents — a case where nobody
            // failed to load anything. `agents === undefined` is the one condition that is only
            // true when the query has never once returned successfully, so this alert can only
            // ever claim a load failure while that is actually what happened.
            <p
              className="mt-2 w-full max-w-2xl text-sm text-destructive"
              role="alert"
            >
              Your coworkers couldn't be loaded, so there's no one to send this
              to yet.
            </p>
          ) : null}
        </div>
        {/*
         * A carousel rather than the wrapping grid `/agents` uses, and the difference is on purpose.
         * This is a one-row teaser under the composer: a grid that wrapped here would push the row
         * down the page every time somebody shared another Bot. `/agents` is the browse surface and
         * wraps.
         *
         * What it replaces was `flex flex-row` with no wrap over cards that have no `shrink-0`, so
         * the fifth public Bot squeezed all five — the same failure `/agents` had just been fixed
         * for, still sitting here.
         */}
        <div className="mt-10 w-full max-w-2xl">
          {/*
           * The heading is repeated in each arm rather than hoisted above this conditional:
           * `CarouselPrevious`/`CarouselNext` read the carousel's own context, so they must stay
           * inside `<Carousel>`, and the heading shares that row with them once populated. Each
           * arm also reserves the same ~180px of body beneath it — a skeleton here, the
           * carousel's 144×180 cards, or the empty/error state's own `h-[180px]` — so the section
           * holds its own height across all four states and the composer sitting above it on
           * this centred column does not move when the query settles or fails.
           */}
          {loading ? (
            <>
              <h2 className="font-bold text-lg">Explore agents</h2>
              <Skeleton className="mt-4 h-[180px]" />
            </>
          ) : explore?.length ? (
            // Wins over `failed`: a failed background refetch does not clear TanStack Query's
            // cached `data`, so a stale carousel here beats an error card claiming there is
            // nothing to explore, which would be false while this list is still populated.
            <Carousel opts={{ align: "start" }}>
              <div className="flex flex-row items-center justify-between gap-4">
                <h2 className="font-bold text-lg">Explore agents</h2>
                {/*
                 * `static` undoes the primitive's own absolute placement, which parks these either
                 * side of the row and off the edge of a prose-width column. They belong on the
                 * heading's baseline, where the section's other decisions are.
                 */}
                <div className="flex items-center gap-2">
                  <CarouselPrevious className="static translate-x-0 translate-y-0" />
                  <CarouselNext className="static translate-x-0 translate-y-0" />
                </div>
              </div>
              {/* `-ml-4`/`pl-4` is the primitive's own gap convention; `basis-auto` keeps each
                  slide the card's own 144px instead of a full-width slide. */}
              <CarouselContent className="-ml-4 mt-4">
                {explore.map((agent) => (
                  <CarouselItem className="basis-auto pl-4" key={agent.id}>
                    <Link search={{ agent: agent.id }} to="/channel/new">
                      <AgentCard agent={agent} />
                    </Link>
                  </CarouselItem>
                ))}
              </CarouselContent>
            </Carousel>
          ) : failed && agents === undefined ? (
            // `agents === undefined` narrows this to "the query has never once returned
            // successfully" — not merely "the last request errored". `?.length` alone can't
            // tell that apart from a slice that loaded and is genuinely empty: TanStack Query
            // never clears `data` on a failed background refetch, so once the query has
            // resolved even one response, `agents` stays defined and `explore`'s emptiness is a
            // fact about that response, not a symptom of the failure. Rendering the destructive
            // card there would say the opposite of what a populated composer beside it (still
            // working off that same, successfully loaded `agents`) proves.
            <>
              <h2 className="font-bold text-lg">Explore agents</h2>
              <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
                <EmptyHeader>
                  <EmptyTitle className="text-destructive">
                    Agents shared with you couldn't be loaded.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            </>
          ) : (
            // Reached both when the query never failed and `explore` is genuinely empty, and
            // when it failed but `agents` is defined — a loaded, empty slice either way. Same
            // plain copy for both: an empty roster is a fact, not an error.
            <>
              <h2 className="font-bold text-lg">Explore agents</h2>
              <Empty className="mt-4 h-[180px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    Nobody has shared an agent with you yet.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            </>
          )}
        </div>
      </div>
    </>
  );
}
