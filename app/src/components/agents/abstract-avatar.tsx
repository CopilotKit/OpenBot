import Avatar from "boring-avatars";

export function AbstractAvatar({
  name,
  seed,
  size = 40,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
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
