import { IconUser } from "@tabler/icons-react";
import { initialsOf } from "@/lib/organizations/words";
import { cn } from "@/lib/utils";

/**
 * A person's picture, or their initials on the tint the account row uses, or a person's mark for
 * somebody OpenBot knows neither a name nor an address for: how a member is drawn wherever people
 * are listed (an organization's members, the people offered to a team).
 */
export function PersonAvatar({
  person,
  className,
}: {
  person: { name: string | null; email: string; image: string | null };
  className?: string;
}) {
  const initials = initialsOf(person);
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/10 text-foreground/70 text-xs",
        className,
      )}
    >
      {person.image ? (
        <img alt="" className="size-full object-cover" src={person.image} />
      ) : initials ? (
        initials
      ) : (
        <IconUser aria-hidden="true" className="size-4" />
      )}
    </div>
  );
}
