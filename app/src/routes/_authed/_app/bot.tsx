import { CopilotChat } from "@copilotkit/react-core/v2";
import { IconPlus } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const agentId = agent ?? "risk-analyst";

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
      <header className="border-b px-6 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Browser Bot</h1>
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
