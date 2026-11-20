import { IconDeviceDesktopOff } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import type { ClientError } from "@/lib/client";
import { COMPUTER_LIMIT_REACHED } from "@/lib/computers/refusal";
import { cn } from "@/lib/utils";

/**
 * A computer that can't be opened, and asking again won't change that (`settledRefusal`): the app's empty state, a
 * heading and the server's own sentence, calm rather than red, with nothing to press that would only be refused again.
 *
 * At the organization's computer limit, an admin gets the way to Computers, where stopping one makes room. Anybody
 * else reads the server's sentence, which says to ask an admin.
 *
 * `compact` leaves out the icon and tightens the spacing, for a small frame (the screen's tile beside a conversation),
 * where the whole sentence and the link have to fit.
 */
export function ComputerBlocked({
  title,
  refusal,
  className,
  compact = false,
}: {
  title: string;
  refusal: ClientError;
  className?: string;
  compact?: boolean;
}) {
  const role = useQuery(currentUserQueryOptions()).data?.role;
  const makeRoom =
    refusal.code === COMPUTER_LIMIT_REACHED && isOrganizationAdmin(role);
  return (
    <Empty
      className={cn(compact ? "gap-2 p-3" : "gap-3 p-4", className)}
      data-slot="computer-blocked"
    >
      <EmptyHeader className={compact ? "gap-1" : undefined}>
        {compact ? null : (
          <EmptyMedia variant="icon">
            <IconDeviceDesktopOff />
          </EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{refusal.message}</EmptyDescription>
      </EmptyHeader>
      {makeRoom ? (
        <EmptyContent>
          {/* A link that looks like a button: it goes somewhere, so it is a link to assistive technology too. */}
          <Link
            // Merged as Button merges it, so the outline's border wins over the base's transparent one.
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            to="/admin/computers"
          >
            Open Computers
          </Link>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
