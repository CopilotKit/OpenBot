import Avatar from "boring-avatars";
import { useBotLook } from "@/components/agents/bot-look";
import { BotOrb } from "@/components/agents/bot-orb";
import { SolidFace } from "@/components/agents/solid-face";

/** A Bot's avatar: its orb, a solid face, or its generated face, as the active skin asks. */
export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  const look = useBotLook();
  if (look === "orb") {
    return <BotOrb name={name} seed={seed} size={size} />;
  }
  if (look === "solid") {
    return <SolidFace name={name} seed={seed} size={size} />;
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
