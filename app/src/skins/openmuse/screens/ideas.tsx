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
 * Ideas: the next steps the centre Bot's background research suggested, and the research itself.
 * Both are OpenBot's own sections, so starting, dismissing and running research behave as on the
 * Bot's page.
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
            detail={`${bot.name} suggests next steps here once background research is on.`}
            icon={IconBulb}
            title="No suggestions yet"
          />
        ) : (
          <SuggestionsInbox agentId={bot.id} />
        )}
        <ProactiveResearchSettings agentId={bot.id} />
      </div>
    </MuseScreen>
  );
}
