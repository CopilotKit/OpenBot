import { Link, useNavigate } from "@tanstack/react-router";
import { ManageSection } from "@/components/bot-profile/manage";
import { BotActivityTab, BotProfile } from "@/components/bot-profile/profile";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import { useBot } from "@/components/bot-profile/use-bot-reads";
import { PageShell } from "@/components/layout/page-shell";
import { BOT_TAB_LABEL, BOT_TABS, type BotTab } from "@/lib/agents/bot-tabs";
import { cn } from "@/lib/utils";

/**
 * A Bot's own page, in three tabs: Profile (what it is for and its state with you), Activity (what
 * it is doing and has done) and Settings (its settings rows and what can be done to it). The open
 * tab is in the address, so a link can open the page on one.
 */
export function BotProfileRoutePage({
  agentId,
  tab = "profile",
}: {
  agentId: string;
  tab?: BotTab;
}) {
  const navigate = useNavigate();
  const agent = useBot(agentId);
  const name = agent.data?.name ?? "Bot";
  const toRoster = () => void navigate({ to: "/bots" });
  return (
    <PageShell
      backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
      // No description: the Bot's own role, under its orb just below, says what this page is about.
      title={name}
    >
      {/* Drawn whatever the Bot's read is doing, so the space under the title never jumps. */}
      <nav aria-label="Bot page sections" className="flex gap-1">
        {BOT_TABS.map((each) => (
          <Link
            aria-current={each === tab ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-muted-foreground text-sm hover:bg-foreground/5",
              each === tab && "bg-foreground/5 font-medium text-foreground",
            )}
            key={each}
            params={{ agentId }}
            search={each === "profile" ? {} : { tab: each }}
            to="/bots/$agentId"
          >
            {BOT_TAB_LABEL[each]}
          </Link>
        ))}
      </nav>
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          Couldn't open this Bot. It may not be shared with you.
        </p>
      ) : tab === "activity" ? (
        <BotActivityTab agentId={agentId} />
      ) : tab === "settings" ? (
        <>
          <BotSettingsRows agent={agent.data} />
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
        </>
      ) : (
        <BotProfile agent={agent.data} />
      )}
    </PageShell>
  );
}
