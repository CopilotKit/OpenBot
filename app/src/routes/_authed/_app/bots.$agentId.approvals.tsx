import { createFileRoute } from "@tanstack/react-router";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/** This Bot's Approvals: the rules for when it stops and asks you, in both editions. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose which actions this Bot can take without your approval."
      title="Approvals"
    >
      {(agent) => <BotApprovalRules agentId={agent.id} />}
    </BotSubpage>
  );
}
