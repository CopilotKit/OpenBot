import {
  IconBuilding,
  IconMail,
  IconPlus,
  IconSettings,
  IconUserCircle,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnythingCut } from "@/hooks/use-anything-cut";
import type {
  OrganizationSummary,
  OwnOrganizations,
} from "@/lib/organizations/queries";
import { cn } from "@/lib/utils";

/**
 * The person's organizations at the top of the account menu: the one they are working in checked,
 * the others one click away, its settings, the invitations waiting for their answer, and New
 * organization for somebody who may create one.
 *
 * Drawn only where OpenBot lists the person's organizations (`useOrganizationChoices`), so for
 * everybody else the menu is the one it always was. The rows take the menu's own item spacing from
 * `itemClassName`. The account menu grows to a long name (`accountMenuClassName`), and a name too
 * long even for that reads whole in a tooltip.
 */
export function OrganizationMenuItems({
  choices,
  invitationsWaiting,
  itemClassName,
  onNew,
  switching,
}: {
  choices: OwnOrganizations;
  /**
   * How many invitations wait for the person's answer. The entry is drawn when some do, and without
   * a count when they could not be read (null), so the page that says why is still one click away.
   */
  invitationsWaiting: number | null;
  itemClassName: string;
  /** Open the New organization dialog, which lives outside the menu so it outlasts it. */
  onNew: () => void;
  /**
   * `useSwitchOrganization()` from whatever draws the menu. The menu closes on a choice and takes
   * these rows with it, so the switch is held by something that is still there when it ends.
   */
  switching: { pending: boolean; run: (organizationId: string) => void };
}) {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="px-2">Organizations</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(organizationId: string) =>
            switching.run(organizationId)
          }
          value={choices.currentId}
        >
          {choices.organizations.map((organization) => (
            <OrganizationRow
              className={itemClassName}
              disabled={switching.pending}
              key={organization.id}
              organization={organization}
            />
          ))}
        </DropdownMenuRadioGroup>
        {choices.organizations.length > 0 ? (
          <DropdownMenuItem
            className={itemClassName}
            nativeButton={false}
            render={<Link to="/settings/organization" />}
          >
            <IconSettings />
            Organization settings
          </DropdownMenuItem>
        ) : null}
        {invitationsWaiting === null || invitationsWaiting > 0 ? (
          <DropdownMenuItem
            className={itemClassName}
            nativeButton={false}
            render={<Link to="/invitations" />}
          >
            <IconMail />
            Invitations
            {invitationsWaiting === null ? null : (
              <span
                className="ml-auto pl-3 text-muted-foreground text-xs tabular-nums"
                data-slot="invitations-waiting"
              >
                <span aria-hidden="true">{invitationsWaiting}</span>
                <span className="sr-only">, {invitationsWaiting} waiting</span>
              </span>
            )}
          </DropdownMenuItem>
        ) : null}
        {choices.canCreate ? (
          <DropdownMenuItem className={itemClassName} onClick={onNew}>
            <IconPlus />
            New organization
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * One organization to switch to. A name the menu still cuts short reads whole in a tooltip, on
 * hover and when the keyboard highlights the row (the menu highlights a row by focusing it), as the
 * account row's own tooltip does. Cutting is only paint: the row's name for assistive technology is
 * always the whole name.
 */
function OrganizationRow({
  className,
  disabled,
  organization,
}: {
  className: string;
  disabled: boolean;
  organization: OrganizationSummary;
}) {
  const { ref, cut } = useAnythingCut<HTMLDivElement>();
  return (
    <Tooltip disabled={!cut}>
      <TooltipTrigger
        // The row is the menu's radio item first, and says so, whatever the tooltip names it.
        data-slot="dropdown-menu-radio-item"
        render={
          <DropdownMenuRadioItem
            // Room on the right for the check, which the menu's item spacing would take back.
            className={cn(className, "pr-8")}
            closeOnClick
            disabled={disabled}
            ref={ref}
            value={organization.id}
          />
        }
      >
        {/* The person's own organization carries a person's mark; one they share, a building. */}
        {organization.personal ? <IconUserCircle /> : <IconBuilding />}
        <span className="min-w-0 truncate">{organization.name}</span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12}>
        <span className="min-w-0 break-words">{organization.name}</span>
      </TooltipContent>
    </Tooltip>
  );
}
