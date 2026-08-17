import { CopilotChat } from "@copilotkit/react-core/v2";
import { createFileRoute } from "@tanstack/react-router";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotThread } from "@/lib/copilot/bot-thread";

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
  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Browser Bot</h1>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        {/* Remount when switching Bots so chat state stays bound to the selected agent. */}
        {threadId ? (
          <CopilotChat agentId={agentId} key={agentId} threadId={threadId} />
        ) : null}
      </div>
    </div>
  );
}
