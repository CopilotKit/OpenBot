import { IconListCheck } from "@tabler/icons-react";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotNeedsYou } from "@/components/needs-you/board";
import { isHeld, loadFailureText } from "@/lib/load-failure";
import { useFuse } from "../context";
import { ErrorNotice, FuseEmpty, FuseScreen } from "../ui";

/**
 * Activity: what the centre Bot is waiting on you for, then what it is doing, has scheduled and has
 * finished. Both are OpenBot's own sections from the Bot's page, under OpenFuse's title. The board
 * lists the Bot's tasks and what it asked, so the sections below leave those out; a task the board
 * leaves out, one it delegated that has finished or one marked done, is listed below under Done.
 */
export function ActivityScreen() {
  const { bot } = useFuse();
  return (
    <FuseScreen title="Activity">
      {bot ? (
        <div className="[&>section:first-child]:mt-0">
          <BotNeedsYou agentId={bot.id} />
          <BotActivitySections agentId={bot.id} boardAbove />
        </div>
      ) : (
        <NoBot />
      )}
    </FuseScreen>
  );
}

/**
 * What a screen about the centre Bot shows without one: nothing while the roster loads, the failure
 * when its read failed (calm when OpenBot is holding off), and "No Bots yet" only for a roster that
 * loaded empty.
 */
export function NoBot() {
  const { roster } = useFuse();
  if (roster.pending) return null;
  if (roster.failed)
    return (
      <ErrorNotice
        error={loadFailureText(
          roster.failed,
          "Couldn't load your Bots. Try again in a moment.",
        )}
        held={isHeld(roster.failed)}
      />
    );
  return (
    <FuseEmpty
      detail="Create one with New Bot on the Bots page."
      icon={IconListCheck}
      title="No Bots yet"
    />
  );
}
