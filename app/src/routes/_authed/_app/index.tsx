import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  redirect,
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
import { heldFileOf } from "@/components/channels/composer/attachments";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { WorkingNow } from "@/components/channels/working-now";
import { BusinessLink } from "@/components/edition/business-link";
import { HomeField, useHomeIntro } from "@/components/home/home-field";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
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
import { fallbackBot, useStartChannel } from "@/lib/channels/start";
import {
  deploymentCapabilitiesQueryOptions,
  useAttachmentLimits,
} from "@/lib/deployment/queries";
import { editionOf } from "@/lib/edition-guard";
import { useClearWhenHoldEnds } from "@/lib/held-ends";
import {
  type Failure,
  failureOf,
  failureSaid,
  isHeld,
  loadFailure,
  unavailableSaid,
} from "@/lib/load-failure";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { usePickedBotModel } from "@/lib/models/run-model";
import { newId } from "@/lib/new-id";
import { takeInvitationLink } from "@/lib/organizations/invitation-link";
import { useAnyBotSkillCommands } from "@/lib/plugins/skill-commands";
import { loadFirstScreen } from "@/lib/route-data";
import { cn } from "@/lib/utils";

/** How many Bots the home page shows before pointing to the rest. Two rows of two. */
const EXPLORE_SHOWN = 4;

/**
 * How long the heading waits for a conversation list the loader did not have in time. Long enough
 * for a slow server or one failed read (retried once, a second later), short enough that a list that
 * never comes leaves a page without a heading only briefly.
 */
const GREETING_WAIT_MS = 2000;

/**
 * Home's heading, said once and never changed: the words a person has started reading stay.
 *
 * Whether to greet somebody's first conversation by name depends on the conversation list. The
 * loader waits for it only briefly, so when it has not come by the time the page draws, the line is
 * kept, empty, until the list answers or fails or `GREETING_WAIT_MS` passes, and the greeting is
 * chosen then. The kept line is as tall as the taller of the two greetings it could be (each is laid
 * out unseen in the same place), so the box under it never moves when the words arrive.
 */
function Greeting() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const choose = () =>
    firstConversationGreeting(
      user,
      channels.isSuccess && channels.data.length === 0,
    );
  // Whether the list was still on its way when the page drew, so the line has to be kept for it.
  const [waits] = useState(() => channels.isPending);
  const [greeting, setGreeting] = useState(() =>
    channels.isPending ? undefined : choose(),
  );
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!waits) return;
    const timer = setTimeout(() => setWaited(true), GREETING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waits]);
  // Chosen in the render that sees the list settle, so no frame is drawn with the words known and
  // not yet shown.
  if (greeting === undefined && (!channels.isPending || waited))
    setGreeting(choose());
  const heading = "text-2xl font-semibold tracking-tight text-center";
  if (!waits) return <h1 className={heading}>{greeting}</h1>;
  const could = [
    ...new Set([
      firstConversationGreeting(user, true),
      firstConversationGreeting(user, false),
    ]),
  ];
  return (
    <div className="grid items-end justify-items-center">
      {could.map((words) => (
        <span
          aria-hidden
          className={cn(heading, "invisible [grid-area:1/1]")}
          key={words}
        >
          {words}
        </span>
      ))}
      <h1 className={cn(heading, "[grid-area:1/1]", greeting && "home-said")}>
        {greeting}
      </h1>
    </div>
  );
}

export const Route = createFileRoute("/_authed/_app/")({
  /*
   * `ask`: words to start the box with, as Teach a Bot's Try it hands over a task a Bot just learned. Only put in the
   * box: nothing is sent until the person sends it.
   */
  validateSearch: z.object({ ask: z.string().max(2000).optional() }),
  // The edition decides whether there is an Explore section at all, so it is read before the page draws: the
  // personal edition would otherwise show Explore's skeleton and then take it away.
  beforeLoad: async ({ context, preload }) => {
    /*
     * Somebody who opened an invitation's link before signing in lands here once they have, and
     * is handed on to the invitation they came for (lib/organizations/invitation-link.ts).
     */
    // A hover must change nothing, and the visit takes the invitation: taking it here would spend the
    // link before anybody has been taken to it.
    const invitationId = preload ? undefined : takeInvitationLink();
    if (invitationId)
      throw redirect({
        to: "/invitations/$invitationId",
        params: { invitationId },
      });
    await editionOf(context.queryClient);
  },
  loader: ({ context }) =>
    loadFirstScreen(context.queryClient, [
      channelListQueryOptions(),
      agentListQueryOptions(),
      deploymentCapabilitiesQueryOptions(),
    ]),
  component: RouteComponent,
});

function RouteComponent() {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const {
    data: agents,
    isPending: loading,
    isError: failed,
    error: agentsError,
  } = useQuery(agentListQueryOptions());
  const explore = agents?.filter(isSharedWithYou);
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const attachmentLimits = useAttachmentLimits();
  /*
   * The personal edition has nobody to share a Bot with. Its Explore lists the Bots included with
   * OpenBot, and when there are none it shows nothing: "Nobody has shared a Bot with you yet" was
   * not true of it. A Bots list that fails to load is said under the composer already.
   */
  const personal = capabilities.data?.edition === "personal";
  // The box's message is kept in its draft until its conversation has it; a suggestion has no draft.
  const typedStart = useStartChannel("home");
  const { pending } = typedStart;
  const suggested = useStartChannel();
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
  const [error, setError] = useState<Failure | null>(restored?.error ?? null);
  // A hold is about now: said until the organization answers again, then gone (lib/held-ends.ts).
  // The words stay in the box to send again.
  useClearWhenHoldEnds(error, () =>
    setError((shown) => (shown === error ? null : shown)),
  );
  /*
   * Whether the person has typed in the box since it was last filled. A start that fails while they
   * are writing something else does not overwrite it: it stays stashed, for the next home page.
   */
  const typed = useRef(false);
  /* The message box's area, which the orb's field behind the page follows. */
  const area = useRef<HTMLDivElement>(null);
  const intro = useHomeIntro();
  /*
   * The placeholder's code, fetched while home is open, so Send draws it at once. It is split into
   * its own file, and fetched only on the first Send it was: until it arrived, home stood there with
   * its box emptied and nothing to say the message went, as long as a second on a slow connection.
   * A fetch that fails is tried again by the Send itself.
   */
  useEffect(() => {
    const placeholder = router.routesByPath["/start/$startId"];
    if (placeholder)
      void router.loadRouteChunk(placeholder)?.catch(() => undefined);
  }, [router]);
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

  /*
   * Every skill any of the person's Bots offers. The Bot is not known until it is chosen with `@` or
   * routed to after sending, so the menu offers them all and sending picks a Bot that has the one
   * used. Without this the box fell back to a placeholder command no Bot has.
   */
  const { commands: skillCommands } = useAnyBotSkillCommands(
    agents?.map((agent) => agent.id) ?? [],
  );
  /** Default recipient when the composer draft has no mention. */
  const fallback = fallbackBot(agents);
  /*
   * The model and thinking effort to run on, picked before OpenBot has picked the Bot. It starts on
   * the catalogue's default and is saved with the conversation the Bot answers in, before the first
   * message runs, as `/channel/new` saves it.
   */
  const models = useQuery(modelCatalogueQueryOptions());
  const draftModel = usePickedBotModel(models.data, agents);
  const { pickFor } = draftModel;

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
   *
   * A starter task starts the same way, from its own click. It was never typed in the box, so the
   * box keeps whatever the person had written there, and a failure puts back only its reason.
   */
  const startBehind = async (
    pendingId: string,
    draft: ComposerDraft,
    starter = false,
  ) => {
    const { startChosen, startPicked } = starter ? suggested : typedStart;
    // A `/` skill stays at the start of the words, where the server finds it and gives the Bot its
    // instructions, only if the Bot holds it (server/src/plugins/picked-skill.ts).
    try {
      if (draft.agentId) {
        // Recorded and started as one sequence, shared with `/channel/new`: the person already
        // decided, and the trail has to say so wherever they decided it.
        const { pick, notUsed } = await pickFor(draft.agentId);
        await startChosen(
          draft.agentId,
          draft.text,
          pick,
          pendingId,
          draft.attachments,
        );
        notUsed?.();
        return;
      }
      // OpenBot picks, as it does for a new conversation started with nobody in To:.
      await startPicked({
        text: draft.text,
        skills: draft.commandIds,
        roster: agents,
        files: draft.attachments,
        pendingId,
        pickFor,
      });
    } catch (caught) {
      stashFailedStart(
        starter
          ? {
              text: "",
              error: failureOf(caught, "Couldn't start that task. Try again."),
            }
          : {
              text: draft.text,
              error: failureOf(
                caught,
                "Couldn't start the conversation. Try again.",
              ),
              files: draft.attachments
                .map(heldFileOf)
                .filter((file) => file !== undefined),
            },
      );
      if (router.state.location.pathname === pendingStartPath(pendingId))
        await navigate({ replace: true, to: "/" });
    } finally {
      endPendingStart(pendingId);
    }
  };

  /**
   * The conversation opens NOW, as a placeholder showing the message under the "Thinking" line, and
   * the Bot is picked and the channel made behind it; see `pending-start.ts`. Waiting here for both
   * is what kept send looking dead for seconds.
   */
  const send = async (draft: ComposerDraft, starter = false) => {
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
    void startBehind(pendingId, draft, starter);
  };

  return (
    <>
      <SidebarToggleBar>
        <BusinessLink />
      </SidebarToggleBar>
      {/*
       * Home scrolls inside the pane, so a long Explore list can be reached. The gutter is kept on
       * both sides from the first paint: where a scrollbar takes width (Windows, OpenBot Desktop's
       * WebView2), one that appears once a list arrives would otherwise nudge the centred heading
       * and box sideways.
       */}
      <div
        className={cn(
          "relative isolate flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges] flex flex-col items-center w-full p-4 mt-8",
          intro && "home-intro",
        )}
      >
        {/* OpenBot's orb, spread out behind the message box. On the first Home of a visit it
            draws itself in while the heading, the box and Explore Bots rise in (styles.css). */}
        <HomeField area={area} intro={intro} />
        {/* No product-name label above the greeting: the sidebar already names the product, and a
            second heading over the first made the page open on a word that says nothing. */}
        {/* Only the heading and the box are centred in the column, by auto margins rather than
            justify-content: safe, which older WebKit drops. What arrives later, the hint, the
            error lines and Explore Bots, hangs below the box without taking part in the
            centring, so none of it can move them. When the window is shorter than this group the
            margins collapse to nothing and the heading stays reachable. */}
        <div className="relative my-auto flex w-full flex-col items-center">
          <div className="flex flex-col items-center" data-intro="heading">
            <Greeting />
          </div>
          <div
            className="mt-8 w-full flex flex-col items-center"
            data-intro="box"
            ref={area}
            onKeyDownCapture={() => {
              typed.current = true;
            }}
            onPasteCapture={() => {
              typed.current = true;
            }}
          >
            <StarterSuggestions
              bot={fallback}
              disabled={pending || suggested.pending}
              onSelect={async (message) => {
                if (!fallback) return;
                // Sent as a message written in the box is, to the Bot the tasks are offered for.
                await send(
                  {
                    text: message,
                    commandIds: [],
                    attachments: [],
                    agentId: fallback.id,
                    isEmpty: false,
                  },
                  true,
                );
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
              // Files wait in the box until the message has a conversation to go to; see `startBehind`.
              holdsFilesUntilSent
              // An unsent first message stays in the box when somebody looks elsewhere.
              draftKey="home"
              attachmentLimits={attachmentLimits}
              modelPicker={
                <ModelPicker
                  catalogue={models.data}
                  disabled={!fallback}
                  onChange={draftModel.choose}
                  value={draftModel.value}
                />
              }
              {...(restored
                ? {
                    initialValue: restored.text,
                    ...(restored.files ? { initialFiles: restored.files } : {}),
                  }
                : asked
                  ? { initialValue: asked, autoFocus: true }
                  : {})}
              onSubmit={(draft) => send(draft)}
            />
          </div>
          <div className="absolute inset-x-0 top-full flex flex-col items-center pb-8">
            {/* The hint rises in with the box on a first visit; Explore below carries its own rise. */}
            <div
              className="flex w-full flex-col items-center"
              data-intro="hint"
            >
              {error ? (
                <p
                  className="mt-2 w-full max-w-2xl text-sm text-destructive"
                  role="alert"
                >
                  {failureSaid(error)}
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
                  {loadFailure(
                    agentsError,
                    "Couldn't load your Bots, so there's no one to send this to. Try again in a moment.",
                  )}
                </p>
              ) : (
                // In the page from the first paint and invisible until there is a Bot to send to, so
                // its arrival moves nothing. Said out loud: a message that silently reaches somebody
                // you did not choose is the kind of surprise that costs trust the first time it happens.
                <p
                  className={cn(
                    "mt-2 w-full max-w-2xl text-xs text-muted-foreground text-center",
                    !fallback && "invisible",
                  )}
                >
                  OpenBot picks the right Bot. Type <code>@</code> to choose
                  one.
                </p>
              )}
            </div>
            {/*
             * Up to four Bots, two to a row, as compact cards that fill the column. A teaser under the
             * composer, not the place to browse: the rest are one "All Bots" away. Explore hangs below
             * the centred heading and box, so none of its states can move them. Each state takes at least
             * h-36, the room two rows of cards need, so a skeleton gives way to a list no shorter than it.
             */}
            <div className="mt-10 w-full max-w-2xl" data-intro="explore">
              {!personal && (loading || capabilities.isPending) ? (
                <>
                  <h2 className="font-semibold text-base">Explore Bots</h2>
                  <Skeleton className="mt-4 h-36" />
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
                  <ul className="mt-4 grid min-h-36 grid-cols-1 content-start gap-3 sm:grid-cols-2">
                    {explore.slice(0, EXPLORE_SHOWN).map((agent) => (
                      <li className="min-w-0" key={agent.id}>
                        <Link search={{ agent: agent.id }} to="/channel/new">
                          <AgentCard agent={agent} appearance="row" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : personal ? null : failed &&
                agents === undefined &&
                isHeld(agentsError) &&
                !error ? (
                // OpenBot holding off (a move, a brief outage) is said once, under the composer, and
                // the list fills in by itself when it is back (lib/load-failure.tsx). Saying the same
                // sentence here again read as two things wrong.
                <>
                  <h2 className="font-semibold text-base">Explore Bots</h2>
                  <Skeleton className="mt-4 h-36" />
                </>
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
                  <Empty
                    className={
                      // OpenBot holding off for now is not a failure (lib/load-failure.tsx).
                      unavailableSaid(agentsError)
                        ? "mt-4 h-36 border border-dashed"
                        : "mt-4 h-36 border border-dashed border-destructive"
                    }
                  >
                    <EmptyHeader>
                      <EmptyTitle className="text-destructive">
                        {loadFailure(
                          agentsError,
                          "Couldn't load the Bots shared with you.",
                        )}
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
                  <Empty className="mt-4 h-36 border border-dashed">
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
        </div>
      </div>
      {/* A Bot already working somewhere, and the way to it. Nothing while every Bot is idle. */}
      <WorkingNow channels={channels.data} />
    </>
  );
}
