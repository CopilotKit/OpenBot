import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

/** A screen to open, as a link at the foot of a card. */
export type SettingsScreenLink = { to: string; label: string };

/**
 * The link at the foot of every settings card to the screen the setting lives on: "Open Settings ›".
 *
 * One look for every card, the admin cards' and the personal ones'. In the primary colour with a
 * chevron, underlined on hover, as the app's other links to a screen are (What if's "Open Apps", the
 * setup checklist's pages); the chevron is the app's mark for "this opens another screen". An
 * underlined word is the app's link inside a sentence, and these stand on their own line.
 */
export function ScreenLink({ to, label }: SettingsScreenLink) {
  return (
    <Link
      className="inline-flex items-center gap-0.5 self-start rounded-sm font-medium text-primary text-xs underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring"
      data-screen-link
      to={to as never}
    >
      {label}
      <IconChevronRight aria-hidden className="size-3.5" />
    </Link>
  );
}

/** Several screens to open, on one line where they fit. */
export function ScreenLinks({
  links,
}: {
  links: readonly SettingsScreenLink[];
}) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {links.map((link) => (
        <ScreenLink key={link.to} {...link} />
      ))}
    </div>
  );
}
