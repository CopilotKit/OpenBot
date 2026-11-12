import { IconListCheck } from "@tabler/icons-react";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotNeedsYou } from "@/components/needs-you/board";
import { useFuse } from "../context";
import { FuseEmpty, FuseScreen } from "../ui";

/**
 * Activity: what the centre Bot is waiting on you for, then what it is doing, has scheduled and has
 * finished. Both are OpenBot's own sections from the Bot's page, under OpenFuse's title.
 */
export function ActivityScreen() {
  const { bot } = useFuse();
  return (
    <FuseScreen title="Activity">
      {bot ? (
        <div className="[&>section:first-child]:mt-0">
          <BotNeedsYou agentId={bot.id} />
          <BotActivitySections agentId={bot.id} />
        </div>
      ) : (
        <NoBot />
      )}
    </FuseScreen>
  );
}

export function NoBot() {
  return (
    <FuseEmpty
      detail="Create one with New Bot on the Bots page."
      icon={IconListCheck}
      title="No Bots yet"
    />
  );
}
