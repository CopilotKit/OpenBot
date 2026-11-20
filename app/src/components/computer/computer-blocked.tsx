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
 * `inline` draws the same thing in spans with no action, for a place that is itself a button (the screen's tile in a
 * conversation, which opens the full-size view where the action is).
 */
export function ComputerBlocked({
  title,
  refusal,
  className,
  inline = false,
}: {
  title: string;
  refusal: ClientError;
  className?: string;
  inline?: boolean;
}) {
  const role = useQuery(currentUserQueryOptions()).data?.role;
  const makeRoom =
    !inline &&
    refusal.code === COMPUTER_LIMIT_REACHED &&
    isOrganizationAdmin(role);
  if (inline)
    return (
      <span
        className={cn(
          "flex flex-col items-center justify-center gap-2 p-4 text-center text-balance",
          className,
        )}
        data-slot="computer-blocked"
      >
        <span className="mb-1 flex size-8 items-center justify-center rounded-lg bg-muted text-foreground">
          <IconDeviceDesktopOff aria-hidden="true" className="size-4" />
        </span>
        <span className="font-heading font-medium text-foreground text-sm tracking-tight">
          {title}
        </span>
        <span className="max-w-sm text-muted-foreground text-sm/relaxed">
          {refusal.message}
        </span>
      </span>
    );
  return (
    <Empty className={cn("gap-3 p-4", className)} data-slot="computer-blocked">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconDeviceDesktopOff />
        </EmptyMedia>
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
