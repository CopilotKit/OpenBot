import { createFileRoute } from "@tanstack/react-router";
import { AppsSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/** This Bot's Apps: yours Ele may use, and every app Ele holds with whether Ele's ready for you. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/apps")({
  component: AppsPage,
});

function AppsPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Gerir the apps this Bot can use. Liga a tua contas on Connections."
      title="Apps"
    >
      {(agent) => <AppsSections agent={agent} />}
    </BotSubpage>
  );
}
