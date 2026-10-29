import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
import { useRotatingPlaceholder } from "@/hooks/use-rotating-placeholder";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { firstConversationGreeting } from "@/lib/auth/greeting";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  CoworkerRoutingRefusedError,
  routeMessage,
} from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { appConfig } from "@/lib/generated/application-config";
import { homeExamples } from "@/lib/home-examples";
import { cn } from "@/lib/utils";
import { DEFAULT_SKIN, useSkinId } from "@/skins/store";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const explore = agents?.filter(isSharedWithYou);
  const { start, startChosen, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);
  // OpenBot's own home. A skin keeps the home it had: the eyebrow, the hint and a still placeholder.
  const openbot = useSkinId() === DEFAULT_SKIN;
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerHasText, setComposerHasText] = useState(false);
  // From the Bots this person can reach, so the placeholder never suggests a job for a Bot they don't
  // have. System Bots count: on a new deployment they are the only ones there.
  const placeholder = useRotatingPlaceholder(
    openbot ? homeExamples(agents ?? []) : [],
    { paused: composerFocused || composerHasText },
  );

  const composerAreaRef = useRef<HTMLDivElement>(null);
  /*
   * The composer does not report focus or its draft, so the area around it listens. The editor's
   * text is read on the events that can change it while the person is here: typing, and leaving.
   */
  useEffect(() => {
    const area = composerAreaRef.current;
    if (!area) return;
    const syncText = () =>
      setComposerHasText(
        Boolean(area.querySelector('[role="textbox"]')?.textContent?.trim()),
      );
    const onFocusIn = () => setComposerFocused(true);
    const onFocusOut = (event: FocusEvent) => {
      setComposerFocused(area.contains(event.relatedTarget as Node | null));
      syncText();
    };
    area.addEventListener("focusin", onFocusIn);
    area.addEventListener("focusout", onFocusOut);
    area.addEventListener("input", syncText);
    return () => {
      area.removeEventListener("focusin", onFocusIn);
      area.removeEventListener("focusout", onFocusOut);
      area.removeEventListener("input", syncText);
    };
  }, []);

  /** Default recipient when the composer draft has no mention. */
  const fallback = defaultAgentProfile(
    agents,
    agents?.find((agent) => agent.visibility === "public"),
  );

  return (
    <>
      <SidebarToggleBar />
      <div className="flex-1 flex flex-col items-center justify-center w-full p-4 mt-8">
        {openbot ? (
          <div className="flex w-full max-w-2xl flex-col items-start">
            <h1 className="text-[32px] font-bold leading-tight tracking-tight">
              {firstConversationGreeting(
                user,
                channels.isSuccess && channels.data.length === 0,
              )}
            </h1>
            <p className="mt-2 max-w-[60ch] text-base text-muted-foreground">
              Ask for an answer, a draft, or a job done on a Bot's own computer.
              {/* The routing sentence is the old hint, shown only while there is a Bot to route to. */}
              {fallback ? (
                <>
                  {" "}
                  {appConfig.brand.productName} picks the right Bot. Type{" "}
                  <code>@</code> to choose one.
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <h2 className="text-sm uppercase text-muted-foreground font-medium tracking-tight text-center">
              {appConfig.brand.productName}
            </h2>
            <h1 className="text-2xl font-bold tracking-tight mt-1.5 text-center">
              {firstConversationGreeting(
                user,
                channels.isSuccess && channels.data.length === 0,
              )}
            </h1>
          </div>
        )}
        <div
          className={cn(
            "w-full flex flex-col items-center",
            openbot ? "mt-6" : "mt-8",
          )}
          ref={composerAreaRef}
        >
          <Composer
            agents={toAgentOptions(agents)}
            className={cn(
              "w-full max-w-2xl",
              // The frame is the composer's own form; it is reached from here through its slot.
              openbot &&
                "[&_[data-slot=composer]]:rounded-[18px] [&_[data-slot=composer]]:border-(--line-strong) [&_[data-slot=composer]]:shadow-(--card-shadow) [&_[data-slot=composer]]:focus-within:border-ring [&_[data-slot=composer]]:focus-within:ring-3 [&_[data-slot=composer]]:focus-within:ring-ring/50",
            )}
            disabled={!fallback}
            editorClassName={openbot ? "text-base" : undefined}
            editorMinHeight={openbot ? 72 : undefined}
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
                } catch (caught) {
                  if (caught instanceof CoworkerRoutingRefusedError)
                    throw caught;
                  agentId = fallback?.id;
                }
                if (!agentId) return;
                await start(agentId, draft.text);
              } catch (caught) {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Couldn't start the conversation. Try again.",
                );
                throw caught;
              }
            }}
            pending={pending}
            placeholder={placeholder}
          />
          {/* On OpenBot's own home the subheader says this, so the hint is only a skin's. */}
          {fallback && !openbot ? (
            // Said out loud: a message that silently reaches somebody you did not choose is the
            // kind of surprise that costs trust the first time it happens.
            <p className="mt-2 w-full max-w-2xl text-xs text-muted-foreground text-center">
              OpenBot picks the right Bot. Type <code>@</code> to choose one.
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
              Couldn't load your Bots, so there's no one to send this to. Reload
              the page.
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
              <h2 className="font-bold text-lg">Explore Bots</h2>
              <Skeleton className="mt-4 h-[180px]" />
            </>
          ) : explore?.length ? (
            // Wins over `failed`: a failed background refetch does not clear TanStack Query's
            // cached `data`, so a stale carousel here beats an error card claiming there is
            // nothing to explore, which would be false while this list is still populated.
            <Carousel
              opts={{ align: "start" }}
              aria-labelledby="explore-agents-heading"
            >
              <div className="flex flex-row items-center justify-between gap-4">
                <h2 id="explore-agents-heading" className="font-bold text-lg">
                  Explore Bots
                </h2>
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
                    <Link
                      className={cn(
                        // The tile is AgentCard's own; its edge and lift are set from here.
                        openbot &&
                          "block rounded-2xl shadow-(--card-shadow) transition-shadow hover:shadow-(--card-shadow-hover) [&>div]:border-(--line-strong) dark:[&>div]:border-(--line-strong) dark:[&>div:hover]:border-ring",
                      )}
                      search={{ agent: agent.id }}
                      to="/channel/new"
                    >
                      <AgentCard agent={agent} appearance="tile" />
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
              <h2 className="font-bold text-lg">Explore Bots</h2>
              <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
                <EmptyHeader>
                  <EmptyTitle className="text-destructive">
                    Couldn't load the Bots shared with you.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            </>
          ) : (
            // Reached both when the query never failed and `explore` is genuinely empty, and
            // when it failed but `agents` is defined — a loaded, empty slice either way. Same
            // plain copy for both: an empty roster is a fact, not an error.
            <>
              <h2 className="font-bold text-lg">Explore Bots</h2>
              <Empty className="mt-4 h-[180px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    Nobody has shared a Bot with you yet.
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
