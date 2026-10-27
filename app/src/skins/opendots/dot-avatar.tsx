import { cn } from "@/lib/utils";

/** OpenDots' four plush coworkers, in the order OpenDots hashes into them. */
export const DOT_CHARACTERS = ["blue", "mint", "orange", "purple"] as const;

export type DotCharacter = (typeof DOT_CHARACTERS)[number];

/**
 * Which plush a Bot wears, decided by its id alone so it is the same on every screen and every
 * reload. The same string hash OpenDots uses for its own Dots, so a Bot looks the way it would there.
 */
export function dotCharacter(identity: string | undefined): DotCharacter {
  if (!identity) return DOT_CHARACTERS[0];
  let hash = 0;
  for (const character of identity) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return DOT_CHARACTERS[hash % DOT_CHARACTERS.length];
}

export function dotImage(identity: string | undefined) {
  return `/skins/opendots/${dotCharacter(identity)}.png`;
}

/**
 * A Bot drawn as an OpenDots plush. Decorative by default: every place it appears names the Bot
 * beside it, so a screen reader hearing the name twice learns nothing.
 */
export function DotAvatar({
  identity,
  name,
  size = 30,
  paused = false,
  className,
}: {
  identity: string | undefined;
  name?: string;
  size?: number;
  paused?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        paused && "saturate-50",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <img
        alt={name ? `${name}` : ""}
        className="block size-full object-contain"
        draggable={false}
        height={size}
        src={dotImage(identity)}
        width={size}
      />
    </span>
  );
}
