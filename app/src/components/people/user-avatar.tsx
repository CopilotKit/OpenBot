export function UserAvatar({
  email,
  image,
  name,
  size = 28,
}: {
  email?: string | null;
  image?: string | null;
  name?: string | null;
  size?: number;
}) {
  const initials =
    name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? email?.slice(0, 2).toUpperCase();
  const label = name || email || "Your avatar";

  return (
    <span
      aria-label={label}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/10 text-xs text-foreground/70"
      role="img"
      style={{ height: size, width: size }}
    >
      {image ? (
        <img
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          src={image}
        />
      ) : (
        initials
      )}
    </span>
  );
}
