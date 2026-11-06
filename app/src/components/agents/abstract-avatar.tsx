import Avatar from "boring-avatars";
import { useBotLook } from "@/components/agents/bot-look";
import { BotKite } from "@/components/agents/kite/kite";
import type { KiteState } from "@/components/agents/kite/kite-draw";

/**
 * A Bot's avatar: its kite, or its face in a skin that has not opted in to kites. `state` is what
 * the kite shows; a face has no states.
 */
export function AbstractAvatar({
  name,
  seed,
  size = 40,
  state = "idle",
}: {
  name: string;
  seed: string;
  size?: number;
  state?: KiteState;
}) {
  if (useBotLook() === "kite") {
    return <BotKite name={name} seed={seed} size={size} state={state} />;
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
