import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotApprovalRules } from "@/components/approvals/bot-rules";
import { AccessSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/access")({
  component: AccessPage,
});

/**
 * Skills and access. In the personal edition this is "What it can do", one page instead of five:
 * what it can use, what it asks you before doing, the goals it works on, and its check-ins, which
 * are separate pages in the team edition. Check-ins sit on the Bot's Memory page there, and the
 * personal edition has no memory (see `offersMemory`), so they are here.
 */
function AccessPage() {
  const { agentId } = Route.useParams();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <BotSubpage
      agentId={agentId}
      description={
        personal
          ? "Manage what this Bot can use, what it asks you before doing, what it works on, and its check-ins."
          : "Manage the skills, apps, and other Bots this Bot can use."
      }
      title={personal ? "What it can do" : "Skills and access"}
    >
      {(agent) => (
        <>
          <AccessSections agent={agent} />
          {personal ? (
            <>
              <BotApprovalRules agentId={agent.id} />
              <BotResponsibilities agentId={agent.id} />
              <ProactiveResearchSettings agentId={agent.id} />
            </>
          ) : null}
        </>
      )}
    </BotSubpage>
  );
}
