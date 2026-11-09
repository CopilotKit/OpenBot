import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import {
  Composer,
  type ComposerDraft,
  toAgentOptions,
} from "@/components/channels/composer";
import { WorkingNow } from "@/components/channels/working-now";
import { BusinessLink } from "@/components/edition/business-link";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { firstConversationGreeting } from "@/lib/auth/greeting";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  beginPendingStart,
  endPendingStart,
  onFailedStart,
  pendingStartPath,
  stashFailedStart,
  takeFailedStart,
} from "@/lib/channels/pending-start";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  CoworkerRoutingRefusedError,
  routeMessage,
} from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { editionOf } from "@/lib/edition-guard";
import { newId } from "@/lib/new-id";
import { useAnyBotSkillCommands } from "@/lib/plugins/skill-commands";

/** How many Bots the home page shows before pointing to the rest. Two rows of two. */
const EXPLORE_SHOWN = 4;

export const Route = createFileRoute("/_authed/_app/")({
  /*
   * `ask`: words to start the box with, as Teach a Bot's Try it hands over a task a Bot just learned. Only put in the
   * box: nothing is sent until the person sends it.
   */
  validateSearch: z.object({ ask: z.string().max(2000).optional() }),
  // The edition decides whether there is an Explore section at all, so it is read before the page draws and the
  // composer never moves when it arrives.
  beforeLoad: async ({ context }) => {
    await editionOf(context.queryClient);
  },
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
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  /*
   * The personal edition has nobody to share a Bot with. Its Explore lists the Bots included with
   * OpenBot, and when there are none it shows nothing: "Nobody has shared a Bot with you yet" was
   * not true of it. A Bots list that fails to load is said under the composer already.
   */
  const personal = capabilities.data?.edition === "personal";
  const { start, startChosen, pending } = useStartChannel();
  const router = useRouter();
  const navigate = useNavigate();
  // A start that failed behind its placeholder comes back here: its words in the box, its reason
  // under it, the way a failed send always left them. Taken on mount, and again whenever one fails
  // while this page is open (somebody who came back here before it failed is looking at it).
  const [restored, setRestored] = useState(takeFailedStart);
  // Read once, as the box reads its words once: the words a link handed over (`ask`).
  const ask = useSearch({ strict: false }).ask;
  const [asked] = useState(ask);
  const [restores, setRestores] = useState(0);
  const [error, setError] = useState<string | null>(restored?.error ?? null);
  /*
   * Whether the person has typed in the box since it was last filled. A start that fails while they
   * are writing something else does not overwrite it: it stays stashed, for the next home page.
   */
  const typed = useRef(false);
  useEffect(
    () =>
      onFailedStart(() => {
        if (typed.current) return;
        const failed = takeFailedStart();
        if (!failed) return;
        setRestored(failed);
        setRestores((count) => count + 1);
        setError(failed.error);
      }),
    [],
  );

  /** Default recipient when the composer draft has no mention. */
  /*
   * Every skill any of the person's Bots offers. The Bot is not known until it is chosen with `@` or
   * routed to after sending, so the menu offers them all and sending picks a Bot that has the one
   * used. Without this the box fell back to a placeholder command no Bot has.
   */
  const { commands: skillCommands } = useAnyBotSkillCommands(
    agents?.map((agent) => agent.id) ?? [],
  );
  const fallback = defaultAgentProfile(
    agents,
    agents?.find((agent) => agent.visibility === "public"),
  );

  /**
   * Pick the Bot and make the channel behind the placeholder `pendingId`.
   *
   * A channel is pinned to one coworker for the life of its thread, so the coworker is chosen now,
   * before it is created. An `@` is an explicit choice and is honoured as-is. With no `@`, the
   * message is routed to the coworker it is for; if that routing cannot run, it falls back to the
   * same default the composer used to always use.
   *
   * Runs on after this page has unmounted, which is the point. A failure goes back to the home
   * composer with the words and the reason, and the person is taken there only if they are still
   * looking at the placeholder; otherwise the next home page they open shows it.
   */
  const startBehind = async (pendingId: string, draft: ComposerDraft) => {
    // A `/` skill stays at the start of the words, where the server finds it and gives the Bot its
    // instructions, only if the Bot holds it (server/src/plugins/picked-skill.ts).
    try {
      if (draft.agentId) {
        // Recorded and started as one sequence, shared with `/channel/new`: the person already
        // decided, and the trail has to say so wherever they decided it.
        await startChosen(draft.agentId, draft.text, undefined, pendingId);
        return;
      }
      let agentId: string | undefined;
      try {
        agentId = (await routeMessage(draft.text, undefined, draft.commandIds))
          .agentId;
      } catch (caught) {
        if (
          draft.commandIds.length ||
          caught instanceof CoworkerRoutingRefusedError
        )
          throw caught;
        agentId = fallback?.id;
      }
      if (!agentId)
        throw new Error("There's no Bot to send this to. Reload the page.");
      await start(agentId, draft.text, undefined, pendingId);
    } catch (caught) {
      stashFailedStart({
        text: draft.text,
        error:
          caught instanceof Error
            ? caught.message
            : "Couldn't start the conversation. Try again.",
      });
      if (router.state.location.pathname === pendingStartPath(pendingId))
        await navigate({ replace: true, to: "/" });
    } finally {
      endPendingStart(pendingId);
    }
  };

  return (
    <>
      <SidebarToggleBar>
        <BusinessLink />
      </SidebarToggleBar>
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
        </div>
        <div
          className="mt-8 w-full flex flex-col items-center"
          onKeyDownCapture={() => {
            typed.current = true;
          }}
          onPasteCapture={() => {
            typed.current = true;
          }}
        >
          <StarterSuggestions
            agentId={fallback?.id}
            disabled={pending}
            onSelect={async (message) => {
              if (!fallback) return;
              await startChosen(fallback.id, message);
            }}
          />
          <Composer
            agents={toAgentOptions(agents)}
            commands={skillCommands}
            className="w-full max-w-2xl"
            disabled={!fallback}
            // The box reads its words once, when it mounts; a start that fails while this page is
            // open is a new box with them in it.
            key={restores}
            {...(restored
              ? { initialValue: restored.text }
              : asked
                ? { initialValue: asked, autoFocus: true }
                : {})}
            onSubmit={async (draft) => {
              // The conversation opens NOW, as a placeholder showing the message, and the Bot is
              // picked and the channel made behind it; see `pending-start.ts`. Waiting here for
              // both is what kept send looking dead for seconds.
              setError(null);
              const pendingId = newId();
              beginPendingStart(pendingId, {
                text: draft.text,
                agentId: draft.agentId,
              });
              await navigate({
                params: { startId: pendingId },
                to: "/start/$startId",
              });
              void startBehind(pendingId, draft);
            }}
          />
          {fallback ? (
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
          {loading || capabilities.isPending ? (
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
          ) : personal ? null : failed && agents === undefined ? (
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
      {/* A Bot already working somewhere, and the way to it. Nothing while every Bot is idle. */}
      <WorkingNow channels={channels.data} />
    </>
  );
}
