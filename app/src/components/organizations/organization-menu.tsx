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
import type { OwnOrganizations } from "@/lib/organizations/queries";
import { cn } from "@/lib/utils";

/**
 * The person's organizations at the top of the account menu: the one they are working in checked,
 * the others one click away, its settings, the invitations waiting for their answer, and New
 * organization for somebody who may create one.
 *
 * Drawn only where OpenBot lists the person's organizations (`useOrganizationChoices`), so for
 * everybody else the menu is the one it always was. The rows take the menu's own item spacing from
 * `itemClassName`, and a long name is cut short where the menu is as narrow as the sidebar.
 */
export function OrganizationMenuItems({
  choices,
  invitationsWaiting,
  itemClassName,
  onNew,
  switching,
}: {
  choices: OwnOrganizations;
  /** How many invitations wait for the person's answer. The entry is drawn only when some do. */
  invitationsWaiting: number;
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
            <DropdownMenuRadioItem
              // Room on the right for the check, which the menu's item spacing would take back.
              className={cn(itemClassName, "pr-8")}
              closeOnClick
              disabled={switching.pending}
              key={organization.id}
              value={organization.id}
            >
              {/* The person's own organization carries a person's mark; one they share, a building. */}
              {organization.personal ? <IconUserCircle /> : <IconBuilding />}
              <span className="min-w-0 truncate">{organization.name}</span>
            </DropdownMenuRadioItem>
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
        {invitationsWaiting > 0 ? (
          <DropdownMenuItem
            className={itemClassName}
            nativeButton={false}
            render={<Link to="/invitations" />}
          >
            <IconMail />
            Invitations
            <span
              className="ml-auto pl-3 text-muted-foreground text-xs tabular-nums"
              data-slot="invitations-waiting"
            >
              <span aria-hidden="true">{invitationsWaiting}</span>
              <span className="sr-only">, {invitationsWaiting} waiting</span>
            </span>
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
