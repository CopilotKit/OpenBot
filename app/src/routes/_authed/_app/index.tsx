import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
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
import { DEFAULT_SKIN, useSkinId } from "@/skins/store";

/** How many Bots the home page shows before pointing to the rest. Two rows of two. */
const EXPLORE_SHOWN = 4;

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
        {/* No product-name label above the greeting: the sidebar already names the product, and a
            second heading over the first made the page open on a word that says nothing. */}
        <div className="flex flex-col items-center">
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            {firstConversationGreeting(
              user,
              channels.isSuccess && channels.data.length === 0,
            )}
          </h1>
          {/* In OpenBot's own look the hint moves up here, ahead of the composer it explains. */}
          {openbot ? (
            <p className="mt-2 max-w-[60ch] text-center text-muted-foreground">
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
          ) : null}
        </div>
        <div
          className="mt-8 w-full flex flex-col items-center"
          ref={composerAreaRef}
        >
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
         * Up to four Bots, two to a row, as compact cards that fill the column. A teaser under the
         * composer, not the place to browse: more than four would push the composer up every time
         * somebody shared another Bot, so the rest are one "All Bots" away. Every state below
         * reserves the same two rows, so the composer above it does not move when the list settles.
         */}
        <div className="mt-10 w-full max-w-2xl">
          {loading ? (
            <>
              <h2 className="font-semibold text-base">Explore Bots</h2>
              <Skeleton className="mt-4 h-[140px]" />
            </>
          ) : explore?.length ? (
            // Wins over `failed`: a failed background refetch does not clear TanStack Query's
            // cached `data`, so a stale list here beats an error card claiming there is
            // nothing to explore, which would be false while this list is still populated.
            <section aria-labelledby="explore-agents-heading">
              <div className="flex flex-row items-center justify-between gap-4">
                <h2
                  id="explore-agents-heading"
                  className="font-semibold text-base"
                >
                  Explore Bots
                </h2>
                {explore.length > EXPLORE_SHOWN ? (
                  <Link
                    className="text-muted-foreground text-sm hover:text-foreground"
                    to="/bots"
                  >
                    All Bots
                  </Link>
                ) : null}
              </div>
              <ul className="mt-4 grid min-h-[140px] grid-cols-1 content-start gap-3 sm:grid-cols-2">
                {explore.slice(0, EXPLORE_SHOWN).map((agent) => (
                  <li className="min-w-0" key={agent.id}>
                    <Link search={{ agent: agent.id }} to="/channel/new">
                      <AgentCard agent={agent} appearance="row" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
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
              <h2 className="font-semibold text-base">Explore Bots</h2>
              <Empty className="mt-4 h-[140px] border border-dashed border-destructive">
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
              <h2 className="font-semibold text-base">Explore Bots</h2>
              <Empty className="mt-4 h-[140px] border border-dashed">
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
