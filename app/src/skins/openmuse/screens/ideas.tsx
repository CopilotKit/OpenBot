import { IconBulb } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { proactiveSuggestionsQueryOptions } from "@/lib/proactive";
import { useMuse } from "../context";
import { MuseEmpty, MuseScreen } from "../ui";
import { NoBot } from "./activity";

/**
 * Ideas: what the centre Bot's check-ins found, and its check-ins themselves. Both are OpenBot's own
 * sections, so starting, hiding and running a check-in behave as on the Bot's page.
 */
export function IdeasScreen() {
  const { bot } = useMuse();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  if (!bot) {
    return (
      <MuseScreen title="Ideas">
        <NoBot />
      </MuseScreen>
    );
  }
  const none =
    suggestions.data !== undefined &&
    !suggestions.data.some((suggestion) => suggestion.agentId === bot.id);
  return (
    <MuseScreen title="Ideas">
      <div className="[&>section:first-child]:mt-0">
        {none ? (
          <MuseEmpty
            detail={`When ${bot.name}'s check-ins find something that needs you, it shows up here.`}
            icon={IconBulb}
            title="Nothing needs you right now"
          />
        ) : (
          <SuggestionsInbox agentId={bot.id} />
        )}
        <ProactiveResearchSettings agentId={bot.id} />
      </div>
    </MuseScreen>
  );
}
