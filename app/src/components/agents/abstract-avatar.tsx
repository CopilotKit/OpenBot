import Avatar from "boring-avatars";
import { drawsBotMark, useBotLook } from "@/components/agents/bot-look";
import { BotOrb } from "@/components/agents/bot-orb";

/**
 * A Bot's avatar: its orb or its kite, or its face in a skin that has opted in to neither.
 * `BotOrb` draws whichever mark the skin asks for.
 */
export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  if (drawsBotMark(useBotLook())) {
    return <BotOrb name={name} seed={seed} size={size} />;
  }

  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full"
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <span aria-hidden="true" className="contents">
        <Avatar name={seed} size={size} />
      </span>
    </span>
  );
}
