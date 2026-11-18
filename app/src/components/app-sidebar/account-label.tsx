import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnythingCut } from "@/hooks/use-anything-cut";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import { OpenBotVersion } from "../layout/openbot-version";

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
    <div className="size-[28px] shrink-0 bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
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
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 text-left *:leading-4 group-data-[collapsible=icon]:sr-only">
        <span className="truncate text-sm trackint-tight">{person}</span>
        <OpenBotVersion className="text-right text-[10px] leading-3 text-muted-foreground" />
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
 * The account menu's popup: at least as wide as the account row, and wider where a row's words need
 * it (an organization's long name), up to 24rem and never past the window's edge.
 */
export const accountMenuClassName =
  "w-max min-w-(--anchor-width) max-w-[min(24rem,var(--available-width))] p-1.5";
/** The spacing of each of the account menu's rows. */
export const accountMenuItemClassName = "gap-2 px-2 py-1.5";

/**
 * The account row as the sidebar draws it: a button that opens the account menu (`children`, the
 * menu's content). When the person's name or their organization's is cut short, it reads whole in
 * a tooltip, on hover and on keyboard focus alike, and never while the menu is open.
 */
export function AccountMenu({ children }: { children: ReactNode }) {
  const { person, organization } = useAccountNames();
  const { ref, cut } = useAnythingCut<HTMLButtonElement>();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
      <Tooltip disabled={!cut || menuOpen}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              ref={ref}
              render={
                <SidebarMenuButton className="h-10 cursor-pointer px-1.5! hover:bg-foreground/5" />
              }
            />
          }
        >
          <AccountLabel />
        </TooltipTrigger>
        <TooltipContent align="start" side="top" sideOffset={8}>
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
