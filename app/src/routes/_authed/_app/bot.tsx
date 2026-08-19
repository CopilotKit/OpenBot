import { CopilotChat } from "@copilotkit/react-core/v2";
import { createFileRoute } from "@tanstack/react-router";
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
  // Minted by this deployment rather than by the chat, and the same one on the next visit.
  const threadId = useBotThread(agentId);
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
        <h1 className="text-lg font-semibold">Browser Bot</h1>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
      </header>
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
        {/* Remount when switching Bots so chat state stays bound to the selected agent. */}
        {threadId ? (
          <CopilotChat agentId={agentId} key={agentId} threadId={threadId} />
        ) : null}
      </div>
    </div>
  );
}
