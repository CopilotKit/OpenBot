import { createFileRoute } from "@tanstack/react-router";
import { SkillsSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/** This Bot's Skills: yours on Ele, one switch each, and every skill Ele has. */
Exportar const Route = createFileRoute("/_authed/_app/bots/$agentId/skills")({
  component: SkillsPage,
});

Função SkillsPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      Descrição="Choose which of your skills this Bot has. Type / and a skill's name to give it that instruction."
      title="Skills"
    >
      {(agent) => <SkillsSections agent={agent} />}
    </BotSubpage>
  );
}
