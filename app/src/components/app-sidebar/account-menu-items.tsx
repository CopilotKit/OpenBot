import { IconLogout } from "@tabler/icons-react";
import { BrandName } from "@/components/edition/brand-name";
import { navigationRender } from "@/components/edition/team-features-dialog";
import { openNewOrganization } from "@/components/organizations/new-organization-dialog";
import { OrganizationMenuItems } from "@/components/organizations/organization-menu";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { useNavigationItems } from "@/lib/navigation";
import {
  useOrganizationChoices,
  useWaitingInvitationCount,
} from "@/lib/organizations/queries";
import { accountMenuItemClassName as userMenuItemClassName } from "./account-label";
import { useSignOut } from "./use-sign-out";

/**
 * What the account menu needs that has to outlive the menu: the organizations it lists, how many
 * invitations wait, and the switch between organizations. A menu's contents mount only while it
 * is open, so these are read by the sidebar that draws the menu, for as long as it is mounted:
 * the organizations refetch when the window comes back, and a switch the server refuses still
 * says so after the menu has closed. The same goes for Sign out: a refused one still shows its
 * toast, and a finished one still goes to sign-in, after the menu has closed.
 */
export function useAccountMenu() {
  // Where OpenBot lists no organizations, the menu has none at all.
  const organizationChoices = useOrganizationChoices();
  const invitationsWaiting = useWaitingInvitationCount();
  const switchOrganization = useSwitchOrganization();
  const signOut = useSignOut();
  return {
    organizationChoices,
    invitationsWaiting,
    switchOrganization,
    signOut,
  };
}

/**
 * What the account menu lists: the organizations, the account entries of the navigation, and Sign out.
 * The old sidebar's footer and the places strip's account button share these, each passing what
 * `useAccountMenu` read (called where it stays mounted, see there) and how to close its own sheet.
 */
export function AccountMenuItems({
  menu: {
    organizationChoices,
    invitationsWaiting,
    switchOrganization,
    signOut,
  },
  onNavigate,
}: {
  menu: ReturnType<typeof useAccountMenu>;
  onNavigate: () => void;
}) {
  const signOutOffered = useSignOutOffered();
  const navigation = useNavigationItems();

  return (
    <>
      {organizationChoices ? (
        <OrganizationMenuItems
          choices={organizationChoices}
          invitationsWaiting={invitationsWaiting}
          itemClassName={userMenuItemClassName}
          onNew={() => {
            // A narrow window's sheet would wait behind the dialog.
            onNavigate();
            openNewOrganization();
          }}
          switching={switchOrganization}
        />
      ) : null}
      {navigation
        .filter((item) => item.section === "account")
        .map((item) => (
          <DropdownMenuItem
            className={userMenuItemClassName}
            key={item.id}
            nativeButton={item.kind === "dialog"}
            // A link closes a narrow window's sheet as it is followed; a dialog has to
            // close it itself, or the sheet waits behind the dialog.
            render={navigationRender(
              item,
              item.kind === "dialog" ? { onClick: onNavigate } : {},
            )}
          >
            <item.icon />
            <BrandName>{item.label}</BrandName>
          </DropdownMenuItem>
        ))}
      {signOutOffered ? (
        <DropdownMenuItem
          className={userMenuItemClassName}
          disabled={signOut.pending}
          onClick={signOut.run}
          variant="destructive"
        >
          <IconLogout />
          Sign out
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
