import {
  IconBuildingBank,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconSearch,
  IconShieldCheck,
  IconSitemap,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { TeamPage } from "@/components/edition/for-a-team";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { NO_PARENT, teamDetailsFrom } from "@/lib/teams/form";
import {
  deleteTeamMutationOptions,
  putTeamMemberMutationOptions,
  removeTeamMemberMutationOptions,
  updateTeamMutationOptions,
} from "@/lib/teams/mutations";
import {
  organizationPeopleQueryOptions,
  possibleParents,
  type TeamPerson,
  type TeamSummary,
  teamListQueryOptions,
  teamMembersQueryOptions,
  teamQueryOptions,
} from "@/lib/teams/queries";
import { queryClient } from "@/query-client";
import { parentLabels } from "./new-team-page";
import { ROLE_WORDS, TEAMS_DESCRIPTION } from "./team-words";

const BACK = {
  label: "Teams",
  linkProps: { to: "/admin/teams" as const },
};

/**
 * One team: what it is called and for, the team it is under, and its people.
 *
 * What is offered follows the server's verdicts. `canManage` (an admin of the organization, or one
 * of the team's maintainers) changes its name and its people. The list's `canCreate` (an admin of
 * the organization) moves it under another team and deletes it. Anybody in it may leave. A team
 * from the company's directory offers none of these: its name and people are the directory's.
 */
function Team({ teamId }: { teamId: string }) {
  const team = useQuery(teamQueryOptions(teamId));
  const list = useQuery(teamListQueryOptions());

  if (team.isPending) return null;
  if (team.error) {
    return (
      <PageShell backButton={BACK} title="Team">
        <p className="text-destructive text-sm" role="alert">
          {team.error.message}
        </p>
      </PageShell>
    );
  }
  return (
    <TeamDetail
      isAdmin={list.data?.canCreate === true}
      team={team.data}
      teams={list.data?.teams ?? []}
    />
  );
}

function TeamDetail({
  team,
  teams,
  isAdmin,
}: {
  team: TeamSummary;
  teams: readonly TeamSummary[];
  /** The server's verdict that this person administers the organization's teams. */
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState<"details" | "parent" | "delete" | null>(
    null,
  );
  const fromDirectory = team.source === "directory";
  const canEdit = team.canManage && !fromDirectory;
  const canMove = isAdmin && !fromDirectory;
  const parent = teams.find((other) => other.id === team.parentTeamId);
  const close = () => setOpen(null);

  return (
    <PageShell
      backButton={BACK}
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
        </PageRows>
      </PageSection>

      <People canEdit={canEdit} team={team} />

      {canMove ? (
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
      {open === "delete" ? <DeleteDialog onClose={close} team={team} /> : null}
    </PageShell>
  );
}

/**
 * The team's people, one row each. Somebody who may manage the team changes a person's role and
 * removes them, and adds a member of the organization. Anybody else reads the list, and may leave.
 */
function People({ team, canEdit }: { team: TeamSummary; canEdit: boolean }) {
  const members = useQuery(teamMembersQueryOptions(team.id));
  const me = useQuery(currentUserQueryOptions()).data;
  const putMember = useMutation(putTeamMemberMutationOptions(queryClient));
  const removeMember = useMutation(
    removeTeamMemberMutationOptions(queryClient),
  );
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const fromDirectory = team.source === "directory";
  const busy = putMember.isPending || removeMember.isPending;
  const failure = putMember.error ?? removeMember.error;
  const rows = members.data ?? [];

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
      {members.isPending ? null : members.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {members.error.message}
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty
          action={canEdit ? addPerson("outline") : undefined}
          icon={IconUsers}
          title="Nobody is in this team yet"
        >
          {fromDirectory
            ? "People show here once the directory puts them in it."
            : "People you add can use everything the team is given."}
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((person, index) => {
            const isSelf = person.id === me?.id;
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
                   * phone.
                   */}
                  <ItemActions className="max-sm:basis-full">
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
                        onClick={() => setLeaving(true)}
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
      {adding ? (
        <AddPersonDialog
          inTeam={rows}
          onClose={() => setAdding(false)}
          team={team}
        />
      ) : null}
      {leaving && me ? (
        <LeaveDialog
          memberId={me.id}
          onClose={() => setLeaving(false)}
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
              {update.error.message}
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
              {update.error.message}
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
 * The organization's members who are not in the team yet, each with an Add. Adding is one write a
 * person, done as it is pressed, so the list shortens as people go in and nothing waits on a Save.
 */
function AddPersonDialog({
  team,
  inTeam,
  onClose,
}: {
  team: TeamSummary;
  inTeam: readonly TeamPerson[];
  onClose: () => void;
}) {
  const people = useQuery(organizationPeopleQueryOptions());
  const add = useMutation(putTeamMemberMutationOptions(queryClient));
  const [search, setSearch] = useState("");
  const taken = new Set(inTeam.map((person) => person.id));
  const outside = (people.data ?? []).filter((person) => !taken.has(person.id));
  const wanted = search.trim().toLowerCase();
  const shown = wanted
    ? outside.filter((person) =>
        `${person.name ?? ""} ${person.email}`.toLowerCase().includes(wanted),
      )
    : outside;
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add people to {team.name}</DialogTitle>
          <DialogDescription>
            They can use everything the team is given, from their next message.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Input
            aria-label="Search people"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or address"
            value={search}
          />
          {add.error ? (
            <p className="text-destructive text-sm" role="alert">
              {add.error.message}
            </p>
          ) : null}
          {people.isPending ? null : people.error ? (
            <p className="text-destructive text-sm" role="alert">
              {people.error.message}
            </p>
          ) : shown.length === 0 ? (
            <PageEmpty
              icon={wanted ? IconSearch : IconUsers}
              title={wanted ? "No matches" : "Everyone is already in"}
            >
              {wanted
                ? `Nobody matches "${search.trim()}".`
                : "Everyone in the organization is in this team."}
            </PageEmpty>
          ) : (
            <ul aria-label="People to add" className="flex flex-col gap-2">
              {shown.map((person) => (
                <li key={person.id}>
                  {/* Filled, not card-coloured: a card is the dialog's own colour and would not show. */}
                  <Item size="sm" variant="muted">
                    <ItemMedia variant="icon">
                      <IconUser />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{person.name ?? person.email}</ItemTitle>
                      {person.name ? (
                        <ItemDescription className="line-clamp-1 break-all">
                          {person.email}
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <Button
                        aria-label={`Add ${person.name ?? person.email}`}
                        disabled={add.isPending}
                        onClick={() =>
                          add.mutate({
                            teamId: team.id,
                            memberId: person.id,
                            role: "member",
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        Add
                      </Button>
                    </ItemActions>
                  </Item>
                </li>
              ))}
            </ul>
          )}
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
            {leave.error.message}
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
}: {
  team: TeamSummary;
  onClose: () => void;
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
            {remove.error.message}
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
                onSuccess: () => void navigate({ to: "/admin/teams" }),
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

/** The personal edition shows that this page applies to a team. */
export function TeamDetailPage({ teamId }: { teamId: string }) {
  return (
    <TeamPage backButton={BACK} description={TEAMS_DESCRIPTION} title="Team">
      <Team teamId={teamId} />
    </TeamPage>
  );
}
