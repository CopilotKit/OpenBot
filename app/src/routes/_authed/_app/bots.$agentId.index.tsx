import { createFileRoute } from "@tanstack/react-router";
import { BotProfileRoutePage } from "@/components/bot-profile/page";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  return <BotProfileRoutePage agentId={agentId} />;
}
