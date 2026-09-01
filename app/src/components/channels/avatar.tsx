import Avatar from "boring-avatars";
import { memo } from "react";
import { cn } from "@/lib/utils";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  participantImages,
  size = 32,
  typing = false,
}: {
  participantIds: string[];
  /** Parallel to participantIds when a server-owned avatar is available. */
  participantImages?: (string | null)[];
  size?: number;
  typing?: boolean;
}) {
  const channelSize = participantIds?.length;

  const avatar =
    channelSize === 1 ? (
      <AvatarFace
        image={participantImages?.[0]}
        seed={participantIds[0]}
        size={size}
      />
    ) : (
      <div className="flex flex-row items-center size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => (
          <div
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            key={c}
            style={{
              height: size / (shown.length / 2),
              width: size / (shown.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            <AvatarFace
              image={participantImages?.[i]}
              seed={c}
              size={size / (shown.length / 2)}
            />
          </div>
        ))}
      </div>
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

function AvatarFace({
  image,
  seed,
  size,
}: {
  image?: string | null;
  seed: string;
  size: number;
}) {
  return image ? (
    <img alt="" className="size-full rounded-full object-cover" src={image} />
  ) : (
    <Avatar className="size-full" name={seed} size={size} />
  );
}

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">Working…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
