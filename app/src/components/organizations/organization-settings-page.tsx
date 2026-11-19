import {
  IconBuilding,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useState } from "react";
import {
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin, type KnownRole } from "@/lib/auth/roles";
import {
  changeMemberRoleMutationOptions,
  deleteOrganizationMutationOptions,
  leaveOrganizationMutationOptions,
  removeOrganizationMemberMutationOptions,
  renameOrganizationMutationOptions,
} from "@/lib/organizations/mutations";
import {
  type OrganizationMemberSummary,
  type OrganizationSummary,
  organizationMembersQueryOptions,
  useOrganizationChoices,
} from "@/lib/organizations/queries";
import {
  givableRoles,
  initialsOf,
  memberControl,
  personName,
  roleChangeQuestion,
  roleInSentence,
  roleName,
} from "@/lib/organizations/words";
import { queryClient } from "@/query-client";
import { SentInvitationsSection } from "./sent-invitations-section";

/** The API's cap on an organization's name, so the field stops where the server does. */
const MAX_NAME_LENGTH = 100;

/**
 * The organization the person is working in: its name, who is in it, and the invitations it sent.
 *
 * What a row offers follows the person's role in this organization, which is the server's verdict
 * from the list of their organizations: an owner or an admin renames it, invites people and removes
 * members; a member reads the name and the members, and may leave. The server decides each of them
 * again and its refusal is drawn in its own sentence.
 */
export function OrganizationSettingsPage() {
  const choices = useOrganizationChoices();
  const organization = choices?.organizations.find(
    (one) => one.id === choices.currentId,
  );
  // Nothing until the list has answered. Where OpenBot lists none, the route never opens this page.
  if (!organization) return null;
  const canManage = isOrganizationAdmin(organization.role);

  return (
    <PageShell
      description={
        canManage
          ? "Rename this organization, invite people to it, and remove members."
          : "See who is in this organization. Its owner and admins manage it."
      }
      title="Organization"
    >
      <PageSection title="Profile">
        <PageRows>
          <NameRow canManage={canManage} organization={organization} />
        </PageRows>
      </PageSection>
      <MembersSection organization={organization} />
      {canManage ? (
        <SentInvitationsSection organization={organization} />
      ) : null}
      {organization.role === "owner" ? (
        <DeleteOrganizationSection organization={organization} />
      ) : null}
    </PageShell>
  );
}

/**
 * The organization's name. A summary that opens a dialog for somebody who may rename it, and the
 * name with nothing to click for a member.
 */
function NameRow({
  canManage,
  organization,
}: {
  canManage: boolean;
  organization: OrganizationSummary;
}) {
  const [open, setOpen] = useState(false);
  const media = (
    <ItemMedia variant="icon">
      <IconBuilding />
    </ItemMedia>
  );
  if (!canManage) {
    return (
      <Item size="sm">
        {media}
        <ItemContent>
          <ItemTitle>Name</ItemTitle>
        </ItemContent>
        <ItemActions className="min-w-0 max-w-[60%]">
          <span className="truncate text-muted-foreground text-sm">
            {organization.name}
          </span>
        </ItemActions>
      </Item>
    );
  }
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        {media}
        <ItemContent>
          <ItemTitle>Name</ItemTitle>
          <ItemDescription>{organization.name}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <RenameOrganizationDialog
        onOpenChange={setOpen}
        open={open}
        organization={organization}
      />
    </>
  );
}

function RenameOrganizationDialog({
  onOpenChange,
  open,
  organization,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: OrganizationSummary;
}) {
  const formId = useId();
  const rename = useMutation(renameOrganizationMutationOptions(queryClient));
  const { reset } = rename;
  const [name, setName] = useState(organization.name);

  // Each opening starts from the name it has, and a refusal from the last one is not news about this one.
  useEffect(() => {
    if (open) {
      setName(organization.name);
      reset();
    }
  }, [open, organization.name, reset]);

  const save = async () => {
    try {
      await rename.mutateAsync({
        organizationId: organization.id,
        name: name.trim(),
      });
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
          <DialogTitle>Rename organization</DialogTitle>
          <DialogDescription>
            Everybody in this organization sees the new name.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (!rename.isPending && name.trim()) void save();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                disabled={rename.isPending}
                id={`${formId}-name`}
                maxLength={MAX_NAME_LENGTH}
                onChange={(event) => {
                  setName(event.target.value);
                  reset();
                }}
                value={name}
              />
            </Field>
          </form>
          {rename.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {rename.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={rename.isPending || !name.trim()}
            form={formId}
            size="sm"
            type="submit"
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A person's picture, or their initials on the tint the account row uses. */
function PersonAvatar({ person }: { person: OrganizationMemberSummary }) {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted-foreground/10 text-foreground/70 text-xs">
      {person.image ? (
        <img alt="" className="size-full object-cover" src={person.image} />
      ) : (
        initialsOf(person)
      )}
    </div>
  );
}

/** A member and the role they are about to be given. */
type RoleChange = {
  member: OrganizationMemberSummary;
  role: KnownRole;
};

/**
 * Who is in the organization, with each person's role, and what their row offers: a Role menu
 * listing the roles the server says the person looking may give them (`assignableRoles`), and
 * Remove or Leave where the membership can end (`removable`).
 */
function MembersSection({
  organization,
}: {
  organization: OrganizationSummary;
}) {
  const members = useQuery(organizationMembersQueryOptions(organization.id));
  const me = useQuery(currentUserQueryOptions()).data;
  const changeRole = useMutation(changeMemberRoleMutationOptions(queryClient));
  // Kept while its dialog closes, so the question does not lose its name on the way out.
  const [removing, setRemoving] = useState<OrganizationMemberSummary | null>(
    null,
  );
  const [removeOpen, setRemoveOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [changing, setChanging] = useState<RoleChange | null>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const viewer = { id: me?.id, role: organization.role };

  // Making somebody an owner, and stepping down, are asked about first. The rest apply at once.
  const giveRole = (change: RoleChange) => {
    changeRole.reset();
    if (roleChangeQuestion(change.member, change.role, me?.id)) {
      setChanging(change);
      setChangeOpen(true);
      return;
    }
    changeRole.mutate({
      organizationId: organization.id,
      personId: change.member.id,
      role: change.role,
    });
  };

  return (
    <PageSection title="Members">
      {members.isPending ? null : members.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {members.error.message}
        </p>
      ) : (
        <PageRows>
          {members.data.map((member, index) => {
            const control = memberControl(member, viewer);
            const name = personName(member);
            const roles = givableRoles(member);
            return (
              <Fragment key={member.id}>
                <Item size="sm">
                  <ItemMedia>
                    <PersonAvatar person={member} />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      <span className="truncate">{name}</span>
                      {member.id === me?.id ? (
                        <span className="shrink-0 font-normal text-muted-foreground">
                          You
                        </span>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-1 break-all">
                      {member.name?.trim()
                        ? `${member.email} · ${roleName(member.role)}`
                        : roleName(member.role)}
                    </ItemDescription>
                  </ItemContent>
                  {control || roles.length > 0 ? (
                    <ItemActions>
                      {roles.length > 0 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                aria-label={`Change role for ${name}`}
                                disabled={changeRole.isPending}
                                size="sm"
                                variant="outline"
                              />
                            }
                          >
                            Role
                            <IconChevronDown className="text-muted-foreground" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-auto min-w-32"
                          >
                            {roles.map((role) => (
                              <DropdownMenuItem
                                key={role}
                                onClick={() => giveRole({ member, role })}
                              >
                                {roleName(role)}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      {!control ? null : control === "leave" ? (
                        <Button
                          onClick={() => setLeaveOpen(true)}
                          size="sm"
                          variant="outline"
                        >
                          Leave organization
                        </Button>
                      ) : (
                        <Button
                          aria-label={`Remove ${name}`}
                          onClick={() => {
                            setRemoving(member);
                            setRemoveOpen(true);
                          }}
                          size="sm"
                          variant="outline"
                        >
                          Remove
                        </Button>
                      )}
                    </ItemActions>
                  ) : null}
                </Item>
                {index !== members.data.length - 1 && <Separator />}
              </Fragment>
            );
          })}
        </PageRows>
      )}
      {changeRole.error ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {changeRole.error.message}
        </p>
      ) : null}
      {changing ? (
        <ChangeRoleDialog
          change={changing}
          onOpenChange={setChangeOpen}
          open={changeOpen}
          organization={organization}
          viewerId={me?.id}
        />
      ) : null}
      {removing ? (
        <RemoveMemberDialog
          member={removing}
          onOpenChange={setRemoveOpen}
          open={removeOpen}
          organization={organization}
        />
      ) : null}
      <LeaveOrganizationDialog
        onOpenChange={setLeaveOpen}
        open={leaveOpen}
        organization={organization}
      />
    </PageSection>
  );
}

/**
 * Asks before making somebody an owner, or before the person steps down from owner, saying what
 * it means, and then changes the role. A refusal stays in the dialog.
 */
function ChangeRoleDialog({
  change,
  onOpenChange,
  open,
  organization,
  viewerId,
}: {
  change: RoleChange;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: OrganizationSummary;
  viewerId: string | undefined;
}) {
  const changeRole = useMutation(changeMemberRoleMutationOptions(queryClient));
  const { reset } = changeRole;
  // A refusal from a previous attempt is not news about this one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const steppingDown =
    roleChangeQuestion(change.member, change.role, viewerId) === "step-down";

  const confirm = async () => {
    try {
      await changeRole.mutateAsync({
        organizationId: organization.id,
        personId: change.member.id,
        role: change.role,
      });
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
            {steppingDown
              ? `Step down as an owner of ${organization.name}?`
              : `Make ${personName(change.member)} an owner of ${organization.name}?`}
          </DialogTitle>
          <DialogDescription>
            {steppingDown
              ? `You become ${roleInSentence(change.role)} and can no longer change who owns this organization. To be an owner again, another owner has to make you one.`
              : "An owner can rename the organization, invite and remove people, and change who owns it. You stay an owner too."}
          </DialogDescription>
        </DialogHeader>
        {changeRole.error ? (
          <p className="text-destructive text-sm" role="alert">
            {changeRole.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={changeRole.isPending}
            onClick={() => {
              void confirm();
            }}
            size="sm"
            variant={steppingDown ? "destructive" : "default"}
          >
            {changeRole.isPending
              ? "Saving…"
              : steppingDown
                ? "Step down"
                : "Make owner"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Asks before removing somebody, naming them, and removes them. A refusal stays in the dialog. */
function RemoveMemberDialog({
  member,
  onOpenChange,
  open,
  organization,
}: {
  member: OrganizationMemberSummary;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: OrganizationSummary;
}) {
  const remove = useMutation(
    removeOrganizationMemberMutationOptions(queryClient),
  );
  const { reset } = remove;
  // A refusal from a previous attempt is not news about this one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const confirm = async () => {
    try {
      await remove.mutateAsync({
        organizationId: organization.id,
        personId: member.id,
      });
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
            Remove {personName(member)} from {organization.name}?
          </DialogTitle>
          <DialogDescription>
            They keep their account and their other organizations. What they
            made here stays here.
          </DialogDescription>
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

/**
 * Asks before the person leaves, and leaves. They are then working in another of their
 * organizations, from home, as after a switch.
 */
function LeaveOrganizationDialog({
  onOpenChange,
  open,
  organization,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: OrganizationSummary;
}) {
  const navigate = useNavigate();
  const leave = useMutation(
    leaveOrganizationMutationOptions(queryClient, async () => {
      await navigate({ to: "/" });
    }),
  );
  const { reset } = leave;
  // A refusal from a previous attempt is not news about this one.
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave {organization.name}?</DialogTitle>
          <DialogDescription>
            You lose access to its Bots and conversations. What you made here
            stays here. To come back, somebody has to invite you again.
          </DialogDescription>
        </DialogHeader>
        {leave.error ? (
          <p className="text-destructive text-sm" role="alert">
            {leave.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={leave.isPending}
            onClick={() =>
              leave.mutate(organization.id, {
                onSuccess: () => onOpenChange(false),
              })
            }
            size="sm"
            variant="destructive"
          >
            {leave.isPending ? "Leaving…" : "Leave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete the organization, for its owner. Asked in a dialog that wants the organization's name typed,
 * because everything in it goes for everybody and can't come back. The server decides whether it can
 * go: a person's own organization and the one that comes with OpenBot stay, and its refusal is said
 * in its own words in the dialog.
 */
function DeleteOrganizationSection({
  organization,
}: {
  organization: OrganizationSummary;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PageSection
      description="Its Bots, conversations and computers are deleted for everyone. Members keep their accounts and their other organizations."
      title="Delete"
    >
      <Button
        className="mt-4"
        onClick={() => setOpen(true)}
        variant="destructive"
      >
        Delete organization
      </Button>
      <DeleteOrganizationDialog
        onOpenChange={setOpen}
        open={open}
        organization={organization}
      />
    </PageSection>
  );
}

function DeleteOrganizationDialog({
  onOpenChange,
  open,
  organization,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: OrganizationSummary;
}) {
  const formId = useId();
  const navigate = useNavigate();
  const remove = useMutation(
    deleteOrganizationMutationOptions(queryClient, async () => {
      await navigate({ to: "/" });
    }),
  );
  const { reset } = remove;
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim() === organization.name.trim();

  // Each opening starts empty, and a refusal from the last one is not news about this one.
  useEffect(() => {
    if (open) {
      setTyped("");
      reset();
    }
  }, [open, reset]);

  const confirm = () => {
    if (!confirmed || remove.isPending) return;
    remove.mutate(organization.id, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {organization.name}?</DialogTitle>
          <DialogDescription>
            Its Bots stop, and its conversations and computers are deleted for
            everyone in it. You can't undo this.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>
                Type {organization.name} to confirm
              </FieldLabel>
              <Input
                autoComplete="off"
                autoFocus
                disabled={remove.isPending}
                id={`${formId}-name`}
                onChange={(event) => {
                  setTyped(event.target.value);
                  reset();
                }}
                value={typed}
              />
            </Field>
          </form>
          {remove.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!confirmed || remove.isPending}
            form={formId}
            size="sm"
            type="submit"
            variant="destructive"
          >
            {remove.isPending ? "Deleting…" : "Delete organization"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
