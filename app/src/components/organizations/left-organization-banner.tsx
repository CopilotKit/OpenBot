import { IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  dismissLeftOrganization,
  leftOrganizationSaid,
  useLeftOrganization,
} from "@/lib/organizations/left";

/**
 * A slim bar, beside the plan and update bars, after the person was removed from the organization
 * they were working in: which one, and where they work now. The app has already taken them home in
 * the other (lib/organizations/left.ts), so the bar only says why. Dismiss closes it; so does moving
 * on to another organization. Drawn as the moved-Bots bar is.
 */
export function LeftOrganizationBanner() {
  const left = useLeftOrganization();
  if (!left) return null;
  return (
    <aside
      aria-label="Organization"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      <p className="min-w-0 flex-1 text-foreground" role="status">
        {leftOrganizationSaid(left)}
      </p>
      <Button
        aria-label="Dismiss"
        onClick={dismissLeftOrganization}
        size="icon-xs"
        variant="ghost"
      >
        <IconX />
      </Button>
    </aside>
  );
}
