import { CopilotChat } from "@copilotkit/react-core/v2";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

/**
 * Which Bot this screen is for.
 *
 * WHATEVER THIS DEPLOYMENT ACTUALLY HAS. The default used to be a hardcoded `risk-analyst`, a name
 * from a tenant package this one is not: on a clone that ships anything else, opening this screen
 * without naming a Bot took the whole page down to an unstyled error boundary, because the chat
 * throws when asked for an agent the runtime never synced. OpenBot exists to be forked, so a Bot
 * name written into a route is a defect on every fork but the one it came from.
 *
 * A named Bot that this deployment does not have is answered in a sentence rather than thrown,
 * for the same reason: a mistyped link is not a crash.
 */
function RouteComponent() {
  const { agent } = Route.useSearch();
  const { data: agents, isPending } = useQuery(agentListQueryOptions());
  const agentId = agent ?? agents?.[0]?.id;
  const bot = agents?.find((candidate) => candidate.id === agentId);
  const known = bot !== undefined;

  if (isPending) return null;
  if (!agentId || !known) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          {agent
            ? `This deployment has no Bot called "${agent}".`
            : "This deployment has no Bots yet."}
        </p>
      </div>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotChat agentId={agentId} key={agentId} name={bot.name} />;
}

function BotChat({ agentId, name }: { agentId: string; name: string }) {
  // Tool calls here act on this Bot's own computer.
  useActiveBot(agentId);
  /*
   * Minted by this deployment rather than by the chat. `history` reports whether Intelligence
   * still recognised the thread this browser remembered from a previous visit; when it did not,
   * `useBotThread` has already swapped in a fresh id on its own; this flag exists only so the
   * page can say so instead of letting the Bot answer as if nothing were missing. `startNew`
   * mints another fresh thread on demand for the New chat control below.
   */
  const { threadId, history, startNew } = useBotThread(agentId);
  /*
   * A turn that ends without an answer has to be said out loud here, because the packaged chat says
   * nothing. It reports a failed run to an `onError` prop and otherwise carries on as though the
   * turn simply finished: the composer unlocks, the spinner goes, and the transcript keeps the
   * person's own message with nothing under it. The banner that would have explained it belongs to
   * a provider this app does not mount.
   */
  const stopped = useStoppedTurn(agentId);

  return (
    <div className="flex h-screen flex-col">
      <SidebarToggleBar />
      <header className="border-b px-6 py-3">
        <div className="flex items-baseline justify-between">
          {/*
           * The Bot this screen is actually showing. A name written into the markup is wrong on
           * every deployment whose package did not happen to use it, which is the same defect the
           * route default above was fixed for: this screen called whichever Bot you opened
           * "Browser Bot", including the one named something else two lines of state away.
           */}
          <h1 className="text-lg font-semibold">{name}</h1>
          {/*
           * Labelled rather than the bare icon button the sidebar uses for its own "start
           * something new" control: that one opens an empty screen, but this one throws away
           * whatever conversation is currently on screen, and a click with that consequence
           * deserves a word, not just a glyph.
           */}
          <Button onClick={startNew} size="sm" variant="ghost">
            <IconPlus />
            New chat
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
      </header>
      {/*
       * Both banners render as plain siblings in this fixed order, never one nested inside the
       * other, so either can appear alone or both together without the layout jumping around
       * depending on which conditions are true.
       */}
      {history === "unavailable" ? (
        <p
          className="border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          data-testid="bot-chat-history-unavailable"
          role="alert"
        >
          Earlier messages in this conversation could not be loaded, and the Bot
          is answering without them.
        </p>
      ) : null}
      {/*
       * Under the header rather than at the end of the transcript, which is where the missing answer
       * was going to be and where the channel draws its own version of this. The packaged chat owns
       * that list and virtualises it, so reaching into it means replacing the whole message view and
       * taking on its scrolling. The cost of putting the sentence here instead is that it is not
       * beside the gap it explains; what it buys is that it is always on screen, whatever the
       * transcript has been scrolled to, and that it survives the next release of the chat.
       */}
      {stopped ? (
        <p
          className="border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          data-testid="bot-chat-stopped"
          role="alert"
        >
          {stopped}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {/*
         * Keyed on the thread as well as the agent. Switching agents was already handled by
         * `agentId`, but `startNew` changes only the thread while the agent stays put, and the
         * packaged chat's own `startNewThread`/`setActiveThreadId` are proven no-ops once
         * `threadId` is a controlled prop (node_modules/@copilotkit/react-core/dist/copilotkit-
         * C4RqjAba.mjs:226-254): asking it to start over does nothing while it still holds the
         * old id. A key that omits the thread would leave the previous conversation on screen
         * under a composer that silently posts to the new one.
         */}
        {threadId ? (
          <CopilotChat
            agentId={agentId}
            key={`${agentId}:${threadId}`}
            threadId={threadId}
          />
        ) : null}
      </div>
    </div>
  );
}
