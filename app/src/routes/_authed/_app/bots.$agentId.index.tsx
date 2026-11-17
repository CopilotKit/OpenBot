import { createFileRoute } from "@tanstack/react-router";
import { BotProfileRoutePage } from "@/components/bot-profile/page";
import { type BotTab, parseBotTab } from "@/lib/agents/bot-tabs";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  // Profile is left out of the address, so a plain link to the Bot needs no search.
  validateSearch: (search: Record<string, unknown>): { tab?: BotTab } => {
    const tab = parseBotTab(search.tab);
    return tab === "profile" ? {} : { tab };
  },
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  return (
    <BotProfileRoutePage
      agentId={agentId}
      tab={Route.useSearch().tab ?? "profile"}
    />
  );
}
