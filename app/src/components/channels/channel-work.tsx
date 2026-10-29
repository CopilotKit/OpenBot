import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import type { ChannelWork } from "@/lib/channels/queries";
import { ProgressRow } from "./progress-row";

/** A Bot as this person knows it: its name and the seed its avatar is drawn from. */
export type KnownBot = { name: string; avatarSeed: string };

/**
 * What a conversation is waiting on, one row each, at the end of the transcript.
 *
 * Driven by the server's list rather than this tab's run, because the work is not this tab's: a Bot
 * the conversation's Bot asked answers out of sight, and a routine fires with nobody's browser
 * open. Without these the conversation looks finished while something is still working on it.
 *
 * Gone when the list empties, which is when the answer is being written into the conversation or
 * the work is over. The caller hides it while its own run is going, so a turn that has just asked
 * another Bot does not show "Asking Ana…" under its own half-written reply.
 */
export function ChannelWorkRows({
  work,
  botOf,
}: {
  work: readonly ChannelWork[] | undefined;
  /** The Bot this person knows by that id, when they know it at all. */
  botOf?: (botId: string) => KnownBot | undefined;
}) {
  if (!work || work.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="channel-work">
      {work.map((entry) => {
        const known = botOf?.(entry.botId);
        const name = known?.name ?? entry.botName;
        return (
          <ProgressRow
            key={entry.key}
            label={labelFor(entry, name)}
            // Seeded by the id when the person does not know the Bot, so the same Bot still draws
            // the same face every time.
            media={
              <AbstractAvatar
                name={name ?? "Bot"}
                seed={known?.avatarSeed ?? entry.botId}
                size={20}
              />
            }
          />
        );
      })}
    </div>
  );
}

function labelFor(entry: ChannelWork, name: string | null): string {
  if (entry.kind === "handoff") {
    return name ? `Asking ${name}…` : "Asking another Bot…";
  }
  return name ? `${name} is running a routine…` : "A routine is running…";
}
