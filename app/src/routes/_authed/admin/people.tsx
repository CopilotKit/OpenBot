import {
  IconLock,
  IconSearch,
  IconShieldCheck,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TeamPage } from "@/components/edition/for-a-team";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { terminateMemberComputersMutationOptions } from "@/lib/enterprise/mutations";
import { loadFailure } from "@/lib/load-failure";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/people")({
  component: PeoplePageInEveryEdition,
});

/** What each provider is called, since the id it registers under is not a name. */
const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
};

/**
 * The second line of a person's row: how they got here, and when they were last here.
 *
 * The address is the title, so this is everything else worth knowing at a glance while deciding
 * whether somebody should still have access.
 */
function describe(person: Person, organization: string | undefined): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? `last signed in ${new Date(person.lastSignedInAt).toLocaleDateString()}`
    : "never signed in";

  if (person.revoked)
    return `${organization ? `Removed from ${organization}` : "Access removed"} · ${providers || "no provider"} · ${when}`;
  if (person.configuredAdmin) {
    return `Admin by configuration · ${when}`;
  }
  if (person.role === "owner")
    return `Owner · ${providers || "no provider"} · ${when}`;
  return `${providers || "no provider"} · ${when}`;
}

/**
 * Under an owner's row, where neither their Admin switch nor Remove can be used: why, and where
 * ownership changes when it can. A person's own organization keeps them as its one owner. In a
 * shared one an owner gives somebody the Owner role from the Members list on Organization settings
 * (organization-settings-page.tsx). Where OpenBot offers no organizations, there is no such page.
 */
function ownerHint(
  person: Person,
  isSelf: boolean,
  organization: { personal: boolean } | undefined,
): string {
  if (organization?.personal)
    return isSelf
      ? "This is your own organization, so you're always its owner."
      : `This is ${nameOf(person)}'s own organization, so they're always its owner.`;
  if (organization)
    return "Owners are always admins. An owner can change a member's role to Owner in Organization settings.";
  return "Owners are always admins.";
}

/** The organization the person is working in, where OpenBot offers organizations. */
function useCurrentOrganization() {
  const choices = useOrganizationChoices();
  return choices?.organizations.find((one) => one.id === choices.currentId);
}

/** What a person is called: their name, or their address when they have not given one. */
function nameOf(person: Person): string {
  return person.name?.trim() || person.email;
}

/**
 * The organization a removal takes somebody out of, where that is all it does: an OpenBot where
 * people may create organizations (`canCreate`, the server's verdict). There, Remove ends the person's membership of this organization alone, and their
 * account, sessions, API keys and other organizations stay theirs. Undefined where OpenBot keeps one
 * organization, where removing somebody still takes them out of OpenBot.
 */
function useRemovalOrganization(): string | undefined {
  const choices = useOrganizationChoices();
  if (!choices?.canCreate) return undefined;
  return choices.organizations.find((one) => one.id === choices.currentId)
    ?.name;
}

function PeoplePage() {
  const [search, setSearch] = useState("");
  /*
   * Debounced, so typing a name is one request rather than one per keystroke against an aggregate
   * over every user in the deployment.
   */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useInfiniteQuery(peopleListQueryOptions(query));
  const rows = people.data?.pages.flatMap((page) => page.people) ?? [];
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  // Offboarding: stops this person's Bots' computers, keeping their disks. Access is unchanged.
  const terminate = useMutation(terminateMemberComputersMutationOptions());
  // Kept while its dialog closes, so the question does not lose its name on the way out.
  const [removing, setRemoving] = useState<Person | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const organization = useRemovalOrganization();
  const current = useCurrentOrganization();
  /*
   * INITIAL_ADMIN_EMAILS names the admins of the deployment's first organization (`default`, as the
   * API addresses it) and of no other, so only its People page says so.
   */
  const inFirstOrganization = useCurrentOrganizationId() === "default";

  // The server refuses these too. Disabling them here is so the screen does not offer something it
  // knows will be refused, not so the rule is enforced in the browser.
  const failure = setRole.error ?? setAccess.error ?? terminate.error;

  return (
    <PageShell
      description="Manage access for people who have signed in. Only admins can access the Admin pages."
      title="People"
    >
      <PageSection
        description={
          inFirstOrganization
            ? "Addresses in INITIAL_ADMIN_EMAILS are always admins. You can't change them here."
            : undefined
        }
        title="Who is here"
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {terminate.data ? (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            Stopped {terminate.data.stopped.length}{" "}
            {terminate.data.stopped.length === 1 ? "computer" : "computers"}
            {terminate.data.failed.length > 0
              ? `. ${terminate.data.failed.length} couldn't be stopped`
              : ""}
            . Their disks are kept.
          </p>
        ) : null}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs.
        */}
        <Input
          aria-label="Search people"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or address"
          value={search}
        />

        {people.isPending ? null : people.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {loadFailure(
              people.error,
              "Couldn't load people. Try again in a moment.",
            )}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty
            icon={query ? IconSearch : IconUsers}
            title={query ? "No matches" : "Nobody has signed in yet"}
          >
            {query
              ? `Nobody matches "${query}".`
              : "People show here once they do."}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((person, index) => {
              const isSelf = person.id === currentUser.data?.id;
              const busy = setRole.isPending || setAccess.isPending;
              /*
               * An owner governs the organization as an admin does, so their Admin switch reads on.
               * Their role is not this switch's to change (only an owner gives ownership away, in
               * Organization settings), and the server keeps the owner, so neither switch nor
               * Remove is offered for them.
               */
              const owner = person.role === "owner";

              return (
                <StaggerItem index={index} key={person.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {person.revoked ? (
                        <IconLock />
                      ) : isOrganizationAdmin(person.role) ? (
                        <IconShieldCheck />
                      ) : (
                        <IconUser />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{nameOf(person)}</ItemTitle>
                      <ItemDescription>
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person, organization)}
                      </ItemDescription>
                      {/* Why the owner's switch and Remove can't be used here. */}
                      {owner && !person.configuredAdmin ? (
                        <ItemDescription>
                          {ownerHint(person, isSelf, current)}
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Removing access is the louder decision, so it is a button rather than a
                       * second switch: two switches on one row invites somebody to flip the wrong
                       * one, and these two do very different things.
                       */}
                      <Button
                        disabled={terminate.isPending}
                        onClick={() => terminate.mutate(person.id)}
                        size="sm"
                        variant="outline"
                      >
                        Stop computers
                      </Button>
                      <Button
                        aria-label={`${person.revoked ? "Restore" : "Remove"} ${nameOf(person)}`}
                        disabled={
                          busy || isSelf || person.configuredAdmin || owner
                        }
                        onClick={() => {
                          // Removing is asked about first. Restoring ends nothing, so it applies at once.
                          if (person.revoked) {
                            setAccess.mutate({
                              userId: person.id,
                              revoked: false,
                            });
                            return;
                          }
                          setRemoving(person);
                          setRemoveOpen(true);
                        }}
                        size="sm"
                        variant={person.revoked ? "outline" : "destructive"}
                      >
                        {person.revoked ? "Restore" : "Remove"}
                      </Button>
                      <Switch
                        aria-label={`Admin: ${person.email}`}
                        checked={isOrganizationAdmin(person.role)}
                        disabled={
                          busy || person.configuredAdmin || isSelf || owner
                        }
                        onCheckedChange={(checked) =>
                          setRole.mutate({
                            userId: person.id,
                            role: checked ? "admin" : "member",
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                  {index !== rows.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}

        {/*
          Only when there is one. A button that says there is more when there is not is worse than
          no button, and this list ends for most deployments on the first page.
        */}
        {people.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={people.isFetchingNextPage}
            onClick={() => people.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {people.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
        {removing ? (
          <RemovePersonDialog
            onOpenChange={setRemoveOpen}
            open={removeOpen}
            organization={organization}
            person={removing}
          />
        ) : null}
      </PageSection>
    </PageShell>
  );
}

/**
 * Asks before removing somebody's access, naming them and saying what ends, and then removes it.
 * A refusal stays in the dialog. Where everybody has an organization of their own (`organization`
 * given), what ends is their membership of this one; where OpenBot keeps one, it is OpenBot.
 */
function RemovePersonDialog({
  onOpenChange,
  open,
  organization,
  person,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: string | undefined;
  person: Person;
}) {
  const remove = useMutation(setPersonAccessMutationOptions(queryClient));
  const { reset } = remove;
  // A refusal from a previous attempt is not news about this one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const confirm = async () => {
    try {
      await remove.mutateAsync({ userId: person.id, revoked: true });
    } catch {
      // The error is on the mutation and drawn below; staying open says "not done".
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Remove {nameOf(person)} from {organization ?? "OpenBot"}?
          </DialogTitle>
          {organization ? (
            <DialogDescription>
              They lose access to {organization}'s Bots and conversations, and
              the apps they connected here are disconnected. They keep their
              account and any other organization they're in. Restore puts them
              back with their role and teams.
            </DialogDescription>
          ) : (
            <DialogDescription>
              They're signed out everywhere and can't sign in again. Their API
              keys, app sign-ins and connected credentials stop working. They
              keep their record and history, and Restore lets them sign in
              again.
            </DialogDescription>
          )}
        </DialogHeader>
        {remove.error ? (
          <p className="text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            onClick={() => {
              void confirm();
            }}
            size="sm"
            variant="destructive"
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The personal edition shows this page's title, and that it applies to a team. */
function PeoplePageInEveryEdition() {
  return (
    <TeamPage
      description="Manage access for people who have signed in. Only admins can access the Admin pages."
      more="Here, you're the only person, and the admin."
      title="People"
    >
      <PeoplePage />
    </TeamPage>
  );
}
