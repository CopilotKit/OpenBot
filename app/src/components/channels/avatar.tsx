import Avatar from "boring-avatars";
import { memo } from "react";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
}: {
  participantIds: string[];
  size?: number;
}) {
  const channelSize = participantIds?.length;

  if (channelSize === 1) {
    return (
      <div className="" style={{ height: size, width: size }}>
        <Avatar className="size-full" name={participantIds[0]} size={size} />
      </div>
    );
  }

  const firstThree = participantIds.slice(0, 3);

  return (
    <div
      className="flex flex-row items-center"
      style={{ height: size, width: size }}
    >
      {firstThree.map((c, i) => {
        return (
          <div
            key={c}
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            style={{
              height: size / (firstThree.length / 2),
              width: size / (firstThree.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            <Avatar
              className="size-full"
              name={c}
              size={size / (firstThree.length / 2)}
            />
          </div>
        );
      })}
    </div>
  );
});
