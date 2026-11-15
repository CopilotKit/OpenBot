import { useQuery } from "@tanstack/react-query";
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

/**
 * The sidebar's account row: the person's avatar, their name, and the release the server runs at
 * the right. The version is as wide as its words, so a build's `main-20261113-9` or
 * `internal-<commit>` reads whole, as a release's `v1.0.2` always did, and the name is what gets
 * cut short when the sidebar is narrow. account-version-layout.test.tsx measures it in a browser.
 *
 * Somebody with more than one organization, or who may create one, reads the one they are working
 * in under their name, since the menu this opens is where they change it. Nobody else has that line.
 */
export function AccountLabel() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const choices = useOrganizationChoices();
  const organization = choices?.organizations.find(
    (one) => one.id === choices.currentId,
  );
  const name = (
    <span className="truncate text-sm trackint-tight">
      {currentUser?.name || currentUser?.email}
    </span>
  );
  return (
    <>
      <UserAvatar />
      <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        {organization ? (
          <span className="grid min-w-0 text-left *:leading-4">
            {name}
            <span className="truncate text-muted-foreground text-xs">
              {organization.name}
            </span>
          </span>
        ) : (
          name
        )}
        <OpenBotVersion className="text-right text-[10px] leading-3 text-muted-foreground" />
      </span>
    </>
  );
}
