import {
  IconBuildingBank,
  IconCheck,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconSearch,
  IconShieldCheck,
  IconSitemap,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { TeamPage } from "@/components/edition/for-a-team";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PersonAvatar } from "@/components/organizations/person-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { personName } from "@/lib/organizations/words";
import { SEARCH_MAX } from "@/lib/people/queries";
import { NO_PARENT, teamDetailsFrom } from "@/lib/teams/form";
import {
  deleteTeamMutationOptions,
  forgetTeam,
  putTeamMemberMutationOptions,
  removeTeamMemberMutationOptions,
  updateTeamMutationOptions,
} from "@/lib/teams/mutations";
import {
  isInTeam,
  type OrganizationPerson,
  possibleParents,
  type TeamPerson,
  type TeamSummary,
  teamListQueryOptions,
  teamMemberMatchesQueryOptions,
  teamMemberPagesQueryOptions,
  teamQueryOptions,
} from "@/lib/teams/queries";
import { queryClient } from "@/query-client";
import { parentLabels } from "./new-team-page";
import { PeopleTypeahead } from "./people-typeahead";
import { TeamModelsRow } from "./team-models";
import {
  backToTeams,
  type TeamPaths,
  type TeamsShell,
  teamPaths,
} from "./team-paths";
import { ROLE_WORDS, TEAMS_DESCRIPTION } from "./team-words";
import { failureSaid } from "@/lib/load-failure";

/**
 * One team: what it is called and for, the team it is under, and its people.
 *
 * What is offered is the server's verdict on this person and this team, and the page works none of
 * it out: `canManage` changes its name and its people, `canMove` the team it is under, `canDelete`
 * deletes it, and the member the server marks `isCaller` is "you", who may leave. So the one page
 * serves a member, a maintainer and an admin. A team from the company's directory keeps the
 * directory's name and people, and nobody leaves it here.
 */
function Team({ teamId, paths }: { teamId: string; paths: TeamPaths }) {
  const team = useQuery(teamQueryOptions(teamId));
  const list = useQuery(teamListQueryOptions());

  if (team.isPending) return null;
  if (team.error) {
    return (
      <PageShell backButton={backToTeams(paths)} title="Team">
        <p className="text-destructive text-sm" role="alert">
          {failureSaid(team.error)}
        </p>
      </PageShell>
    );
  }
  return (
    <TeamDetail paths={paths} team={team.data} teams={list.data?.teams ?? []} />
  );
}

function TeamDetail({
  paths,
  team,
  teams,
}: {
  paths: TeamPaths;
  team: TeamSummary;
  /** The organization's teams, to name this one's parent and to choose another from. */
  teams: readonly TeamSummary[];
}) {
  const [open, setOpen] = useState<"details" | "parent" | "delete" | null>(
    null,
  );
  const fromDirectory = team.source === "directory";
  const canEdit = team.canManage;
  const canMove = team.canMove;
  const parent = teams.find((other) => other.id === team.parentTeamId);
  const close = () => setOpen(null);

  return (
    <PageShell
      backButton={backToTeams(paths)}
      description={team.description ?? undefined}
      title={team.name}
    >
      <PageSection title="About">
        <PageRows>
          {fromDirectory ? (
            <>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBuildingBank />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>From your company's directory</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    Its name and people come from the directory. Change them
                    there.
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
            </>
          ) : null}
          {canEdit ? (
            <>
              <Item
                render={
                  <button onClick={() => setOpen("details")} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconPencil />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Name and description</ItemTitle>
                  <ItemDescription>
                    {team.description ?? "No description yet"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              <Separator />
            </>
          ) : null}
          <Item
            render={
              canMove ? (
                <button onClick={() => setOpen("parent")} type="button" />
              ) : undefined
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconSitemap />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Parent team</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {parent
                  ? `${parent.name}. People here can also use what ${parent.name} is given.`
                  : "None"}
              </ItemDescription>
            </ItemContent>
            {canMove ? (
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            ) : null}
          </Item>
          <Separator />
          <TeamModelsRow team={team} />
        </PageRows>
      </PageSection>

      <People canEdit={canEdit} team={team} />

      {team.canDelete ? (
        <PageSection
          description="Its people stay in the organization and lose what the team was given. Teams under it move up a level."
          title="Delete"
        >
          <Button
            className="mt-4"
            onClick={() => setOpen("delete")}
            variant="destructive"
          >
            Delete team
          </Button>
        </PageSection>
      ) : null}

      {open === "details" ? (
        <DetailsDialog onClose={close} team={team} />
      ) : null}
      {open === "parent" ? (
        <ParentDialog onClose={close} team={team} teams={teams} />
      ) : null}
      {open === "delete" ? (
        <DeleteDialog onClose={close} paths={paths} team={team} />
      ) : null}
    </PageShell>
  );
}

/**
 * The team's people, one row each, a page at a time, with a search above them that asks the server
 * (as Admin's People does). Somebody who may manage the team changes a person's role and removes
 * them, and adds a member of the organization. Anybody else reads the list, and may leave.
 */
function People({ team, canEdit }: { team: TeamSummary; canEdit: boolean }) {
  const [search, setSearch] = useState("");
  // Debounced, so typing a name is one request rather than one per keystroke.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const members = useInfiniteQuery(teamMemberPagesQueryOptions(team.id, query));
  const putMember = useMutation(putTeamMemberMutationOptions(queryClient));
  const removeMember = useMutation(
    removeTeamMemberMutationOptions(queryClient),
  );
  const [adding, setAdding] = useState(false);
  // The person reading, from their own row (the server marks it), once they press Leave team.
  const [leaving, setLeaving] = useState<TeamPerson | null>(null);
  const fromDirectory = team.source === "directory";
  const busy = putMember.isPending || removeMember.isPending;
  const failure = putMember.error ?? removeMember.error;
  const rows = members.data?.pages.flatMap((page) => page.members) ?? [];

  const addPerson = (variant: "ghost" | "outline") => (
    <Button onClick={() => setAdding(true)} size="sm" variant={variant}>
      <IconPlus />
      Add person
    </Button>
  );

  return (
    <PageSection
      action={canEdit ? addPerson("ghost") : undefined}
      title="People"
    >
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {/*
        Server-side search, as on Admin's People: filtering what already arrived would only search
        the first page. Shown once there is somebody to search, or something typed.
      */}
      {search || query || rows.length > 0 ? (
        <Input
          aria-label="Search people in this team"
          className="mt-4"
          maxLength={SEARCH_MAX}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or address"
          value={search}
        />
      ) : null}
      {members.isPending ? null : members.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(members.error)}
        </p>
      ) : rows.length === 0 && query ? (
        <PageEmpty icon={IconSearch} title="No matches">
          {`Nobody in this team matches "${query}".`}
        </PageEmpty>
      ) : rows.length === 0 ? (
        <PageEmpty
          action={canEdit ? addPerson("outline") : undefined}
          icon={IconUsers}
          title="Nobody is in this team yet"
        >
          {fromDirectory
            ? "People show here once the directory puts them in it."
            : canEdit
              ? "People you add can use everything the team is given."
              : "A maintainer or an admin adds its people."}
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((person, index) => {
            const isSelf = person.isCaller;
            return (
              <div key={person.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {person.role === "maintainer" ? (
                      <IconShieldCheck />
                    ) : (
                      <IconUser />
                    )}
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{person.name ?? person.email}</ItemTitle>
                    <ItemDescription>
                      {[
                        person.name ? person.email : null,
                        isSelf ? "You" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </ItemDescription>
                  </ItemContent>
                  {/*
                   * A role and a button are too much beside a name on a phone, so there they take
                   * a line of their own under the name, where the People page puts its own on a
                   * phone. A role that is only read stays beside the name.
                   */}
                  <ItemActions
                    className={
                      canEdit || (isSelf && !fromDirectory)
                        ? "max-sm:basis-full"
                        : undefined
                    }
                  >
                    {canEdit ? (
                      <Select
                        items={ROLE_WORDS}
                        onValueChange={(role) => {
                          if (role !== "maintainer" && role !== "member")
                            return;
                          putMember.mutate({
                            teamId: team.id,
                            memberId: person.id,
                            role,
                          });
                        }}
                        value={person.role}
                      >
                        <SelectTrigger
                          aria-label={`Role of ${person.name ?? person.email}`}
                          disabled={busy}
                          size="sm"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end" alignItemWithTrigger={false}>
                          <SelectGroup>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="maintainer">
                              Maintainer
                            </SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        {ROLE_WORDS[person.role]}
                      </span>
                    )}
                    {/* Nobody leaves or is removed from a directory team here: the directory decides. */}
                    {fromDirectory ? null : isSelf ? (
                      <Button
                        disabled={busy}
                        onClick={() => setLeaving(person)}
                        size="sm"
                        variant="outline"
                      >
                        Leave team
                      </Button>
                    ) : canEdit ? (
                      <Button
                        aria-label={`Remove ${person.name ?? person.email}`}
                        disabled={busy}
                        onClick={() =>
                          removeMember.mutate({
                            teamId: team.id,
                            memberId: person.id,
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        Remove
                      </Button>
                    ) : null}
                  </ItemActions>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </div>
            );
          })}
        </PageRows>
      )}
      {/* Only when the server says there is another page, as on Admin's People. */}
      {members.hasNextPage ? (
        <Button
          className="mt-4"
          disabled={members.isFetchingNextPage}
          onClick={() => members.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {members.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
      {adding ? (
        <AddPersonDialog onClose={() => setAdding(false)} team={team} />
      ) : null}
      {leaving ? (
        <LeaveDialog
          memberId={leaving.id}
          onClose={() => setLeaving(null)}
          team={team}
        />
      ) : null}
    </PageSection>
  );
}

/** The team's name and what it is for. Mounted only while open, so it starts from what is saved. */
function DetailsDialog({
  team,
  onClose,
}: {
  team: TeamSummary;
  onClose: () => void;
}) {
  const formId = useId();
  const update = useMutation(updateTeamMutationOptions(queryClient));
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Name and description</DialogTitle>
          <DialogDescription>
            Everyone in the organization can see these.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(
                {
                  teamId: team.id,
                  change: teamDetailsFrom({ name, description }),
                },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
                <Input
                  autoComplete="off"
                  id={`${formId}-name`}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-description`}>
                  Description
                </FieldLabel>
                <Textarea
                  className="min-h-20"
                  id={`${formId}-description`}
                  maxLength={500}
                  onChange={(event) => setDescription(event.target.value)}
                  value={description}
                />
              </Field>
            </FieldGroup>
          </form>
          {update.error ? (
            <p className="text-destructive text-sm" role="alert">
              {failureSaid(update.error)}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || update.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The team this one sits under, chosen from the teams it may be put under, or none. */
function ParentDialog({
  team,
  teams,
  onClose,
}: {
  team: TeamSummary;
  teams: readonly TeamSummary[];
  onClose: () => void;
}) {
  const formId = useId();
  const update = useMutation(updateTeamMutationOptions(queryClient));
  const parents = possibleParents(teams, team.id);
  const [parentId, setParentId] = useState(team.parentTeamId ?? NO_PARENT);
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Parent team</DialogTitle>
          <DialogDescription>
            People in {team.name} can also use everything its parent team is
            given.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(
                {
                  teamId: team.id,
                  change: {
                    parentTeamId: parentId === NO_PARENT ? null : parentId,
                  },
                },
                { onSuccess: onClose },
              );
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-parent`}>Parent team</FieldLabel>
              {parents.length === 0 ? (
                <FieldDescription>
                  There's no other team to put it under yet.
                </FieldDescription>
              ) : null}
              <Select
                items={parentLabels(parents)}
                onValueChange={(value) => setParentId(String(value))}
                value={parentId}
              >
                <SelectTrigger className="w-full" id={`${formId}-parent`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_PARENT}>None</SelectItem>
                    {parents.map((other) => (
                      <SelectItem key={other.id} value={other.id}>
                        {other.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </form>
          {update.error ? (
            <p className="text-destructive text-sm" role="alert">
              {failureSaid(update.error)}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={update.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adding people to a team: a type-ahead box over the organization's own members, searched on the
 * server as the admin types (PeopleTypeahead). Who of those found is in the team already comes from
 * the team's own search with the same words, never from reading the whole team, and is asked again
 * just before somebody is added (adding sets their role, which would make a maintainer a member).
 * Adding is one write a person, done as they are chosen, so several go in one after another and
 * nothing waits on a Save. Whoever was added here is listed under the box until the dialog closes.
 */
function AddPersonDialog({
  team,
  onClose,
}: {
  team: TeamSummary;
  onClose: () => void;
}) {
  const add = useMutation(putTeamMemberMutationOptions(queryClient));
  const [search, setSearch] = useState("");
  const matches = useQuery({
    ...teamMemberMatchesQueryOptions(team.id, search),
    enabled: search !== "",
    // Kept while the next search's answer is on its way, as the people found are.
    placeholderData: keepPreviousData,
  });
  const inTeam = matches.data;
  const [added, setAdded] = useState<OrganizationPerson[]>([]);
  // Found to be in the team already when they were chosen.
  const [already, setAlready] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  // Chosen and not yet answered: offered as in the team, and given back if the server refuses.
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const taken = new Set([
    ...(inTeam ?? []),
    ...already,
    ...added.map((person) => person.id),
    ...adding,
  ]);
  const settle = (id: string) =>
    setAdding((now) => new Set([...now].filter((one) => one !== id)));
  const last = added[0];

  const choose = async (person: OrganizationPerson) => {
    setAdding((now) => new Set([...now, person.id]));
    setFailure(null);
    try {
      if (await isInTeam(team.id, person)) {
        setAlready((now) => new Set([...now, person.id]));
        return;
      }
      await add.mutateAsync({
        teamId: team.id,
        memberId: person.id,
        role: "member",
      });
      setAdded((now) => [person, ...now.filter((one) => one.id !== person.id)]);
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : "Couldn't add them. Try again in a moment.",
      );
    } finally {
      settle(person.id);
    }
  };
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      {/*
       * Held near the top, not centred: the list under the box grows and shrinks with every
       * keystroke, and a centred dialog would jump up and down with it.
       */}
      <DialogContent className="top-[8svh] translate-y-0 sm:top-[12svh]">
        <DialogHeader>
          <DialogTitle>Add people to {team.name}</DialogTitle>
          <DialogDescription>
            Type a name or email to find someone in this organization. They can
            use everything the team is given, from their next message.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <PeopleTypeahead
            announcement={
              last ? `${personName(last)} added to ${team.name}` : undefined
            }
            label={`People to add to ${team.name}`}
            onChoose={(person) => void choose(person)}
            onSearch={setSearch}
            unavailable={(person) =>
              taken.has(person.id) ? "In this team" : null
            }
            waiting={search !== "" && matches.isPending}
          />
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          ) : null}
          {added.length > 0 ? (
            <section aria-label={`Added to ${team.name}`}>
              <h3 className="mb-2 font-medium text-muted-foreground text-xs">
                Added
              </h3>
              <ul className="flex flex-col gap-2">
                {added.map((person) => (
                  <li key={person.id}>
                    {/* Filled, not card-coloured: a card is the dialog's own colour and would not show. */}
                    <Item size="sm" variant="muted">
                      <ItemMedia>
                        <PersonAvatar person={person} />
                      </ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle>{personName(person)}</ItemTitle>
                        {person.name ? (
                          <ItemDescription className="line-clamp-1 break-all">
                            {person.email}
                          </ItemDescription>
                        ) : null}
                      </ItemContent>
                      <ItemActions>
                        <IconCheck
                          aria-label="Added"
                          className="size-4 text-muted-foreground"
                        />
                      </ItemActions>
                    </Item>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Leaving is asked about first: nobody who cannot manage the team can put themselves back. */
function LeaveDialog({
  team,
  memberId,
  onClose,
}: {
  team: TeamSummary;
  memberId: string;
  onClose: () => void;
}) {
  const leave = useMutation(removeTeamMemberMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave “{team.name}”?</DialogTitle>
          <DialogDescription>
            You lose what the team was given, such as its Bots. You stay in the
            organization.
          </DialogDescription>
        </DialogHeader>
        {leave.error ? (
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(leave.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={leave.isPending}
            onClick={() =>
              leave.mutate(
                { teamId: team.id, memberId },
                { onSuccess: onClose },
              )
            }
            size="sm"
            variant="destructive"
          >
            {leave.isPending ? "Leaving…" : "Leave team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  team,
  onClose,
  paths,
}: {
  team: TeamSummary;
  onClose: () => void;
  /** Where the list is, in the frame the page is in: where a deleted team's page sends you. */
  paths: TeamPaths;
}) {
  const navigate = useNavigate();
  const remove = useMutation(deleteTeamMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{team.name}”?</DialogTitle>
          <DialogDescription>
            Its people stay in the organization and lose what the team was
            given, from their next message. You can't undo this.
          </DialogDescription>
        </DialogHeader>
        {remove.error ? (
          <p className="text-destructive text-sm" role="alert">
            {failureSaid(remove.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(team.id, {
                // To the list, then drop the team's reads: its page never reads it again.
                onSuccess: () =>
                  void navigate(paths.list()).then(() =>
                    forgetTeam(queryClient, team.id),
                  ),
              })
            }
            size="sm"
            variant="destructive"
          >
            {remove.isPending ? "Deleting…" : "Delete team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The personal edition shows that this page applies to a team. `shell` is the frame it is drawn in,
 * so the back button, and the list a deleted team leaves for, stay in it.
 */
export function TeamDetailPage({
  teamId,
  shell = "app",
}: {
  teamId: string;
  shell?: TeamsShell;
}) {
  const paths = teamPaths(shell);
  return (
    <TeamPage
      backButton={backToTeams(paths)}
      description={TEAMS_DESCRIPTION}
      title="Team"
    >
      <Team paths={paths} teamId={teamId} />
    </TeamPage>
  );
}
