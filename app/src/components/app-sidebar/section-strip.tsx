import { type Icon, IconLogout, IconMessages } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { BrandName } from "@/components/edition/brand-name";
import { Strip, StripItem } from "@/components/layout/strip";
import { openNewOrganization } from "@/components/organizations/new-organization-dialog";
import { OrganizationMenuItems } from "@/components/organizations/organization-menu";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { appConfig } from "@/lib/generated/application-config";
import {
  isNavigationLink,
  type NavigationLink,
  useNavigationItems,
} from "@/lib/navigation";
import { ORB_PALETTES } from "@/lib/orb-palette";
import {
  useOrganizationChoices,
  useWaitingInvitationCount,
} from "@/lib/organizations/queries";
import {
  CONVERSATIONS,
  type SectionId,
  sectionHasPanel,
  useOpenSection,
} from "@/lib/sections";
import { BotsNavBadge } from "../bot-profile/attention";
import { RecordingDot, useLiveRecording } from "../browser/browser-nav-item";
import { navigationRender } from "../edition/team-features-dialog";
import {
  AccountMenu,
  AccountRow,
  accountMenuClassName,
  accountMenuItemClassName,
} from "./account-label";
import { useSignOut } from "./use-sign-out";

/** The orb's palette: periwinkle, the nearest of the eight to OpenBot's own mark. */
const ORB_COLORS = ORB_PALETTES[2];

/** OpenBot's orb at the top of the strip. It goes home, as the product's name did. */
function HomeOrb() {
  return (
    <Link
      aria-label={appConfig.brand.productName}
      className="flex size-9 items-center justify-center rounded-full outline-hidden ring-sidebar-ring focus-visible:ring-2"
      to="/"
    >
      <span
        aria-hidden="true"
        className="bot-orb-still inline-block size-7 rounded-full ring-1 ring-foreground/10"
        style={
          {
            "--c1": ORB_COLORS.c1,
            "--c2": ORB_COLORS.c2,
            "--c3": ORB_COLORS.c3,
            "--c4": ORB_COLORS.c4,
          } as CSSProperties
        }
      />
    </Link>
  );
}

/**
 * A section with a panel (Conversations, Bots): its icon opens the panel without leaving the page; on
 * the section that is already open with its panel showing, it hides the panel, and shows it again.
 */
function PanelItem({
  id,
  label,
  icon,
  end,
}: {
  id: SectionId;
  label: string;
  icon: Icon;
  end?: ReactNode;
}) {
  const { section, show } = useOpenSection();
  const { open, setOpen, isMobile } = useSidebar();
  const current = section === id;
  return (
    <StripItem
      active={current}
      end={end}
      icon={icon}
      label={label}
      onClick={() => {
        // A narrow window's sheet shows the strip and the panel together: nothing to fold.
        if (!isMobile) setOpen(current ? !open : true);
        /*
         * After opening the panel, not before: on a page whose section has none (Routines), opening
         * it asks the frame for a section that has one, which is Conversations. The last section
         * asked for is the one that opens, and it is this one.
         */
        show(id);
      }}
    />
  );
}

/** One of the main menu's destinations with no panel, as a section whose pages it opens. */
function PageItem({ item }: { item: NavigationLink }) {
  const { section, page, show } = useOpenSection();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const recording = useLiveRecording();
  // Skills says when a recording is live: teaching a Bot a task is how a skill is recorded.
  const recordingHere = item.id === "skills" ? recording : null;
  return (
    <StripItem
      active={section === item.id}
      // Kept open for a page no section owns, it is not that page: shown open, not said current.
      aria-current={page === item.id ? "page" : undefined}
      end={recordingHere ? <RecordingDot {...recordingHere} /> : null}
      icon={item.icon}
      label={item.label}
      /*
       * Already on its page, the link goes nowhere, so the page cannot hand the strip back: a
       * panel opened over it (Bots on Routines) kept its icon lit and Routines could not be chosen.
       * Opening the section here does what arriving on the page would have.
       */
      onClick={() => {
        if (pathname === item.to) show(item.id);
      }}
      render={<Link to={item.to} />}
      tooltip={recordingHere?.label}
    />
  );
}

/** The account at the strip's foot, and the menu it opens: organizations, the account's pages, Sign out. */
function StripAccount() {
  const navigation = useNavigationItems();
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();
  // Where OpenBot lists no organizations, the menu has none at all.
  const organizationChoices = useOrganizationChoices();
  const invitationsWaiting = useWaitingInvitationCount();
  const switchOrganization = useSwitchOrganization();
  const { setOpenMobile } = useSidebar();
  return (
    <AccountMenu>
      <DropdownMenuContent
        align="end"
        className={accountMenuClassName}
        side="right"
        sideOffset={8}
      >
        <AccountRow />
        <DropdownMenuSeparator />
        {organizationChoices ? (
          <OrganizationMenuItems
            choices={organizationChoices}
            invitationsWaiting={invitationsWaiting}
            itemClassName={accountMenuItemClassName}
            onNew={() => {
              // A narrow window's sheet would wait behind the dialog.
              setOpenMobile(false);
              openNewOrganization();
            }}
            switching={switchOrganization}
          />
        ) : null}
        {navigation
          .filter((item) => item.section === "account")
          .map((item) => (
            <DropdownMenuItem
              className={accountMenuItemClassName}
              key={item.id}
              nativeButton={item.kind === "dialog"}
              // A link closes a narrow window's sheet as it is followed; a dialog has to close it
              // itself, or the sheet waits behind the dialog.
              render={navigationRender(
                item,
                item.kind === "dialog"
                  ? { onClick: () => setOpenMobile(false) }
                  : {},
              )}
            >
              <item.icon />
              <BrandName>{item.label}</BrandName>
            </DropdownMenuItem>
          ))}
        {signOutOffered ? (
          <DropdownMenuItem
            className={accountMenuItemClassName}
            disabled={signOut.pending}
            onClick={signOut.run}
            variant="destructive"
          >
            <IconLogout />
            Sign out
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </AccountMenu>
  );
}

/**
 * The app's strip: the orb, Conversations, the main menu's destinations in the shared list's order
 * (`lib/navigation.ts`), and the account at the foot. A section with a panel switches the panel and
 * leaves the page alone; any other opens its page.
 */
export function SectionStrip() {
  const navigation = useNavigationItems();
  return (
    <Strip footer={<StripAccount />} header={<HomeOrb />}>
      <PanelItem icon={IconMessages} id={CONVERSATIONS} label="Conversations" />
      {navigation
        .filter(isNavigationLink)
        .filter((item) => item.section === "primary")
        .map((item) =>
          sectionHasPanel(item.id) ? (
            <PanelItem
              // What waits on you across every Bot; the Bots panel puts a dot on each.
              end={item.id === "bots" ? <BotsNavBadge onIcon /> : undefined}
              icon={item.icon}
              id={item.id}
              key={item.id}
              label={item.label}
            />
          ) : (
            <PageItem item={item} key={item.id} />
          ),
        )}
    </Strip>
  );
}
