import Avatar from "boring-avatars";
import { BotOrb } from "@/components/agents/bot-orb";
import { DEFAULT_SKIN, useSkinId } from "@/skins/store";

/**
 * A Bot's avatar. OpenBot's own look draws the Bot as its orb; a skin keeps the face it was
 * designed with.
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
  const skin = useSkinId();
  if (skin === DEFAULT_SKIN) {
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
