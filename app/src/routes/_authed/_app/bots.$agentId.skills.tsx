import { createFileRoute } from "@tanstack/react-router";
import { SkillsSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/** This Bot's Skills: yours on it, one switch each, and every skill it has. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/skills")({
  component: SkillsPage,
});

function SkillsPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose which of your skills this Bot has. Type / and a skill's name to give it that instruction."
      title="Skills"
    >
      {(agent) => <SkillsSections agent={agent} />}
    </BotSubpage>
  );
}
