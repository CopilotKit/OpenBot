import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { stripItemClassName } from "@/components/layout/strip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import { cn } from "@/lib/utils";
import { OpenBotVersion } from "../layout/openbot-version";

/** The version's type beside the account, in the menu's row and on the strip: tiny and quiet. */
const versionClassName = "text-[10px] leading-3 text-muted-foreground";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div
      aria-hidden="true"
      className="size-[28px] shrink-0 bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden"
    >
      {initials}
    </div>
  );
}

/** The person's name, and the organization they are working in where OpenBot lists them. */
function useAccountNames() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const choices = useOrganizationChoices();
  const organization = choices?.organizations.find(
    (one) => one.id === choices.currentId,
  );
  return {
    person: currentUser?.name || currentUser?.email,
    organization: organization?.name,
  };
}

/**
 * The sidebar's account row: the person's avatar, their name, and the release the server runs at
 * the right. The version is as wide as its words, so a build's `main-20261113-9` or
 * `internal-<commit>` reads whole, as a release's `v1.0.2` always did, and the name is what gets
 * cut short when the sidebar is narrow. account-version-layout.test.tsx measures it in a browser.
 *
 * Where OpenBot lists the person's organizations, they read the one they are working in under their
 * name, since the menu this opens is where they change it. Nobody else has that line. It runs the
 * row's whole width, under the version as well as the name: the version sits on the name's line
 * only, so a build's long one never cuts the organization short.
 */
export function AccountLabel() {
  const { person, organization } = useAccountNames();
  return (
    <>
      <UserAvatar />
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 text-left *:leading-4">
        <span className="truncate text-sm trackint-tight">{person}</span>
        <OpenBotVersion className={cn("text-right", versionClassName)} />
        {organization ? (
          <span className="col-span-2 truncate text-muted-foreground text-xs">
            {organization}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * The account row at the top of the account menu: avatar, name, the release the server runs, and
 * the organization being worked in. Not a menu item: it says whose menu this is.
 */
export function AccountRow() {
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-2 py-1.5"
      data-slot="account-row"
    >
      <AccountLabel />
    </div>
  );
}

/**
 * The account menu's popup: at least as wide as the account row, and wider where a row's words need
 * it (an organization's long name), up to 24rem and never past the window's edge.
 */
export const accountMenuClassName =
  "w-max min-w-(--anchor-width) max-w-[min(24rem,var(--available-width))] p-1.5";
/** The spacing of each of the account menu's rows. */
export const accountMenuItemClassName = "gap-2 px-2 py-1.5";

/**
 * The account, as the strip draws it: the person's avatar at the strip's foot, a button that opens
 * the account menu (`children`, the menu's content). Their name, and their organization where
 * OpenBot lists them, read in a tooltip on hover and keyboard focus, never while the menu is open.
 * The menu itself starts with the whole account row (`AccountLabel`), version included.
 */
export function AccountMenu({ children }: { children: ReactNode }) {
  const { person, organization } = useAccountNames();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
      <Tooltip disabled={menuOpen}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              className={cn(stripItemClassName, "rounded-full")}
            />
          }
        >
          <UserAvatar />
          {/* Read out as the button's name: whose account, and the organization being worked in. */}
          <span className="sr-only">
            {organization ? `${person}, ${organization}` : person}
          </span>
        </TooltipTrigger>
        <TooltipContent align="center" side="right" sideOffset={8}>
          <span className="grid min-w-0 *:break-words">
            <span>{person}</span>
            {organization ? (
              <span className="text-background/70">{organization}</span>
            ) : null}
          </span>
        </TooltipContent>
      </Tooltip>
      {children}
    </DropdownMenu>
  );
}

/**
 * On OpenBot Cloud (`hostedSignIn`, OpenBot Desktop signed in to it too), the release the server
 * runs, under the strip's avatar: on screen on every page, so a screenshot sent with a bug report
 * says which release it was taken on. Elsewhere only the account menu says it.
 *
 * The strip is narrow, so a build's `main-20261113-9` or `internal-<commit>` wraps, centred, at its
 * hyphens and then wherever it must, and reads whole on two or three lines. A release's `v1.0.2`
 * fits on one. Its digits keep their own widths here, which is what lets the date fit on a line of
 * its own.
 *
 * As wide as the strip and never what makes the strip wider (`w-0 min-w-full`): in a phone's sheet
 * the strip is as wide as what it holds, and a version on one line pushed it from 48px to 84px and
 * the panel beside it over. `wrap-anywhere`, not `wrap-break-word`, for the same reason on a wider
 * window: with break-word the strip's foot grew to the version's longest piece (`20261113-`, wider
 * than the strip) and the date ran past the strip's edges.
 */
export function StripVersion() {
  const cloud =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  if (!cloud) return null;
  return (
    <OpenBotVersion
      className={cn(
        "w-0 min-w-full whitespace-normal px-0.5 text-center normal-nums wrap-anywhere",
        versionClassName,
      )}
    />
  );
}
