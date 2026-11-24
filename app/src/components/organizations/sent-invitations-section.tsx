import { IconMail, IconMailPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { copyText } from "@/components/settings/linked-accounts";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type {
  AssignableRole,
  OrganizationInvitationResponse,
} from "@/lib/api/generated/model";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  cancelSentInvitationMutationOptions,
  inviteToOrganizationMutationOptions,
} from "@/lib/organizations/mutations";
import {
  type OrganizationSummary,
  type SentInvitation,
  sentInvitationPagesQueryOptions,
} from "@/lib/organizations/queries";
import {
  invitationLink,
  roleName,
  sentInvitationLine,
} from "@/lib/organizations/words";
import { SEARCH_MAX } from "@/lib/people/queries";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

/** The API's cap on an address, so the field stops where the server does. */
const MAX_EMAIL_LENGTH = 320;

const ROLES: Record<AssignableRole, string> = {
  member: roleName("member"),
  admin: roleName("admin"),
};

/**
 * A button that copies an invitation's link and says so. Where the browser will not copy (a
 * plain-http address, a refused permission), `onFailed` lets the caller show the link to copy by hand.
 */
function CopyLinkButton({
  label,
  link,
  onFailed,
}: {
  /** Names the invitation for a screen reader where several rows each have this button. */
  label?: string;
  link: string;
  onFailed: (failed: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  // "Copied" for a moment, then the button offers itself again.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      aria-label={label}
      onClick={async () => {
        const ok = await copyText(link, navigator.clipboard);
        setCopied(ok);
        onFailed(!ok);
      }}
      size="sm"
      variant="outline"
    >
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

/**
 * The invitations this organization sent that nobody has accepted: waiting, expired or declined.
 * Drawn only for its owner and admins, who are the ones the server lets read them. A page at a
 * time, with a search by address above them that asks the server, as Admin's People does.
 */
export function SentInvitationsSection({
  organization,
}: {
  organization: OrganizationSummary;
}) {
  const [search, setSearch] = useState("");
  // Debounced, so typing an address is one request rather than one per keystroke.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const invitations = useInfiniteQuery(
    sentInvitationPagesQueryOptions(organization.id, query),
  );
  const rows =
    invitations.data?.pages.flatMap((page) => page.invitations) ?? [];
  const [inviting, setInviting] = useState(false);
  /*
   * A hosted OpenBot: an invitation is an email from OpenBot by CopilotKit, accepted from that email.
   * Its link carries a one-time ticket that only the email has, so there is no link to copy.
   */
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;

  return (
    <PageSection
      action={
        <Button onClick={() => setInviting(true)} size="sm" variant="outline">
          <IconMailPlus />
          Invite
        </Button>
      }
      description="Invite somebody by email. An invitation lasts 7 days."
      title="Invitations"
    >
      {/*
        Server-side search, as on Admin's People: filtering what already arrived would only search
        the first page. Shown once there is an invitation to search, or something typed.
      */}
      {search || query || rows.length > 0 ? (
        <Input
          aria-label="Search invitations"
          className="mt-4"
          maxLength={SEARCH_MAX}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by address"
          value={search}
        />
      ) : null}
      {invitations.isPending ? null : invitations.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(invitations.error)}
        </p>
      ) : rows.length === 0 && query ? (
        <PageEmpty icon={IconSearch} title="No matches">
          {`No invitation matches "${query}".`}
        </PageEmpty>
      ) : rows.length === 0 ? (
        <PageEmpty icon={IconMail} title="No invitations">
          An invitation shows here until the person accepts it.
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((invitation, index) => (
            <Fragment key={invitation.id}>
              <SentInvitationRow
                hosted={hosted}
                invitation={invitation}
                organizationId={organization.id}
              />
              {index !== rows.length - 1 && <Separator />}
            </Fragment>
          ))}
        </PageRows>
      )}
      {/* Only when the server says there is another page, as on Admin's People. */}
      {invitations.hasNextPage ? (
        <Button
          className="mt-4"
          disabled={invitations.isFetchingNextPage}
          onClick={() => invitations.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {invitations.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
      <InviteDialog
        hosted={hosted}
        onOpenChange={setInviting}
        open={inviting}
        organization={organization}
      />
    </PageSection>
  );
}

/**
 * One invitation with its own Cancel, so a refusal is drawn under the row it is about. Only one
 * still waiting has a link worth passing on, and none does on a hosted OpenBot.
 */
function SentInvitationRow({
  hosted,
  invitation,
  organizationId,
}: {
  hosted: boolean;
  invitation: SentInvitation;
  organizationId: string;
}) {
  const cancel = useMutation(cancelSentInvitationMutationOptions(queryClient));
  const [copyFailed, setCopyFailed] = useState(false);
  const link = invitationLink(invitation.id);
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconMail />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle>
            <span className="truncate">{invitation.email}</span>
          </ItemTitle>
          <ItemDescription>{sentInvitationLine(invitation)}</ItemDescription>
        </ItemContent>
        {/* On a phone the buttons take a line under the address, as they do on a team's people. */}
        <ItemActions className="max-sm:basis-full">
          {invitation.status === "pending" && !hosted ? (
            <CopyLinkButton
              label={`Copy link for ${invitation.email}`}
              link={link}
              onFailed={setCopyFailed}
            />
          ) : null}
          <Button
            aria-label={`Cancel invitation for ${invitation.email}`}
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate({ organizationId, invitationId: invitation.id })
            }
            size="sm"
            variant="outline"
          >
            {cancel.isPending ? "Canceling…" : "Cancel"}
          </Button>
        </ItemActions>
      </Item>
      {copyFailed ? (
        <p className="px-4 pb-3 text-destructive text-sm" role="alert">
          Couldn't copy the link. Copy it yourself:{" "}
          <span className="break-all text-foreground">{link}</span>
        </p>
      ) : null}
      {cancel.error ? (
        <p className="px-4 pb-3 text-destructive text-sm" role="alert">
          {failureSaid(cancel.error)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Invites an address with a role, then says what happened in the same dialog: OpenBot emailed the
 * person, or the inviter copies the link and passes it on. A refusal stays in the dialog in the
 * server's own sentence, with the address still typed.
 */
function InviteDialog({
  hosted,
  onOpenChange,
  open,
  organization,
}: {
  hosted: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organization: OrganizationSummary;
}) {
  const formId = useId();
  const invite = useMutation(inviteToOrganizationMutationOptions(queryClient));
  const { reset } = invite;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [sent, setSent] = useState<OrganizationInvitationResponse | null>(null);

  // Each opening starts empty, and what the last one said is not news about this one.
  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("member");
      setSent(null);
      reset();
    }
  }, [open, reset]);

  const send = async () => {
    try {
      setSent(
        await invite.mutateAsync({
          organizationId: organization.id,
          email: email.trim(),
          role,
        }),
      );
    } catch {
      // The error is on the mutation and drawn below; staying on the form says "not done".
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        {sent ? (
          <InvitationSent onDone={() => onOpenChange(false)} sent={sent} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite to {organization.name}</DialogTitle>
              <DialogDescription>
                {hosted
                  ? "They get an email from OpenBot by CopilotKit and accept the invitation from it. It lasts 7 days."
                  : "They see the invitation in OpenBot when they sign in with this address. It lasts 7 days."}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4">
              <form
                id={formId}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!invite.isPending && email.trim()) void send();
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${formId}-email`}>Email</FieldLabel>
                    <Input
                      autoComplete="off"
                      autoFocus
                      disabled={invite.isPending}
                      id={`${formId}-email`}
                      maxLength={MAX_EMAIL_LENGTH}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        reset();
                      }}
                      placeholder="name@example.com"
                      type="email"
                      value={email}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${formId}-role`}>Role</FieldLabel>
                    <Select
                      items={ROLES}
                      onValueChange={(value) => {
                        if (value === "member" || value === "admin")
                          setRole(value);
                      }}
                      value={role}
                    >
                      <SelectTrigger className="w-full" id={`${formId}-role`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(ROLES) as AssignableRole[]).map(
                          (value) => (
                            <SelectItem key={value} value={value}>
                              {ROLES[value]}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      An admin can rename the organization, invite people and
                      remove members.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </form>
              {invite.error ? (
                <p className="mt-4 text-destructive text-sm" role="alert">
                  {failureSaid(invite.error)}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => onOpenChange(false)}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={invite.isPending || !email.trim()}
                form={formId}
                size="sm"
                type="submit"
              >
                {invite.isPending ? "Inviting…" : "Invite"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What happened to an invitation just made: emailed, or a link for the inviter to pass on. */
function InvitationSent({
  onDone,
  sent,
}: {
  onDone: () => void;
  sent: OrganizationInvitationResponse;
}) {
  const [copyFailed, setCopyFailed] = useState(false);
  const { email, id } = sent.invitation;
  const link = invitationLink(id);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {sent.delivery === "emailed" ? "Invitation sent" : "Invitation ready"}
        </DialogTitle>
        <DialogDescription role="status">
          {sent.delivery === "emailed"
            ? `We emailed ${email} an invitation.`
            : `Copy the link and send it to ${email}.`}
        </DialogDescription>
      </DialogHeader>
      {sent.delivery === "link" ? (
        <DialogBody className="mt-4">
          <div className="flex items-center gap-2">
            {/* A fill, not the card colour, which a dialog's own surface already is. */}
            <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-xs">
              {link}
            </code>
            <CopyLinkButton link={link} onFailed={setCopyFailed} />
          </div>
          {copyFailed ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              Couldn't copy the link. Select it and copy it yourself.
            </p>
          ) : null}
        </DialogBody>
      ) : null}
      <DialogFooter className="mt-4">
        <Button onClick={onDone} size="sm">
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
