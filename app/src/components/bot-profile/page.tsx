import { useNavigate } from "@tanstack/react-router";
import { ManageSection } from "@/components/bot-profile/manage";
import { BotProfile } from "@/components/bot-profile/profile";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { useBot } from "@/components/bot-profile/use-bot-reads";
import { PageShell } from "@/components/layout/page-shell";
import { loadFailure } from "@/lib/load-failure";

/** A Bot's own page: its profile, its settings and what can be done to it. */
export function BotProfileRoutePage({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const agent = useBot(agentId);
  const toRoster = () => void navigate({ to: "/bots" });
  return (
    <PageShell
      backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
      // No description: the Bot's own role, under its orb just below, says what this page is about.
      title={agent.data?.name ?? "Bot"}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {loadFailure(
            agent.error,
            "Couldn't open this Bot. It may not be shared with you.",
          )}
        </p>
      ) : (
        <BotProfile
          agent={agent.data}
          manage={
            <ManageSection
              agent={agent.data}
              onDeleted={toRoster}
              onDuplicated={(copyId) =>
                void navigate({
                  params: { agentId: copyId },
                  to: "/bots/$agentId",
                })
              }
              onHidden={toRoster}
            />
          }
          settings={<BotSettingsRows agent={agent.data} />}
        />
      )}
    </PageShell>
  );
}
