import { IconBuilding, IconMail, IconMailOff } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import {
  acceptInvitationMutationOptions,
  declineInvitationMutationOptions,
} from "@/lib/organizations/mutations";
import {
  type ReceivedInvitation,
  receivedInvitationQueryOptions,
  receivedInvitationsQueryOptions,
} from "@/lib/organizations/queries";
import { receivedInvitationLine } from "@/lib/organizations/words";
import { queryClient } from "@/query-client";
import { useSwitchOrganization } from "./use-switch-organization";
import { failureSaid } from "@/lib/load-failure";

/**
 * One invitation as the person it was sent to sees it, in whatever state it is in.
 *
 * Waiting, it offers Accept and Decline. Accepting does not move the person: they keep working
 * where they were, and the row then offers the switch. Expired, declined or canceled, it says so
 * and offers nothing. A refusal is drawn under the row in the server's own sentence while the
 * invitation still waits; one that expired or was canceled meanwhile is said by the row itself.
 */
export function InvitationRow({
  invitation,
  onAccepted,
}: {
  invitation: ReceivedInvitation;
  /** Told when the person has joined, for a list the accepted invitation then leaves. */
  onAccepted?: (invitation: ReceivedInvitation) => void;
}) {
  const accepting = acceptInvitationMutationOptions(queryClient);
  const accept = useMutation({
    ...accepting,
    /*
     * Told before the lists are read again, not from the button's own callback: reading them again
     * takes an accepted invitation out of the list, and this row with it, and a row that has gone
     * hears nothing. Declaring an `onSuccess` over the spread replaces the factory's, so it is
     * called here, by hand.
     */
    onSuccess: async (...args) => {
      onAccepted?.({ ...invitation, status: "accepted" });
      await accepting.onSuccess?.(...args);
    },
  });
  const decline = useMutation(declineInvitationMutationOptions(queryClient));
  const switching = useSwitchOrganization();
  const current = useCurrentOrganizationId();
  const busy = accept.isPending || decline.isPending;
  /*
   * Only while the invitation still waits. A refusal that changed it (it expired or was canceled
   * meanwhile) has the row read again, and the row's own line then says what happened, so the
   * refusal under it would say the same thing twice in two wordings.
   */
  const failure =
    invitation.status === "pending" ? (accept.error ?? decline.error) : null;
  const { name } = invitation.organization;

  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconBuilding />
        </ItemMedia>
        <ItemContent className="min-w-48">
          <ItemTitle>{name}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {receivedInvitationLine(invitation)}
          </ItemDescription>
        </ItemContent>
        {invitation.status === "pending" ? (
          <ItemActions>
            <Button
              aria-label={`Decline invitation to ${name}`}
              disabled={busy}
              onClick={() => {
                accept.reset();
                decline.mutate(invitation.id);
              }}
              size="sm"
              variant="outline"
            >
              {decline.isPending ? "Declining…" : "Decline"}
            </Button>
            <Button
              aria-label={`Accept invitation to ${name}`}
              disabled={busy}
              onClick={() => {
                decline.reset();
                accept.mutate(invitation.id);
              }}
              size="sm"
            >
              {accept.isPending ? "Accepting…" : "Accept"}
            </Button>
          </ItemActions>
        ) : invitation.status === "accepted" &&
          invitation.organization.id !== current ? (
          <ItemActions className="min-w-0">
            <Button
              className="max-w-full"
              disabled={switching.pending}
              onClick={() => switching.run(invitation.organization.id)}
              size="sm"
            >
              <span className="truncate">Switch to {name}</span>
            </Button>
          </ItemActions>
        ) : null}
      </Item>
      {failure ? (
        <p className="px-4 pb-3 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
    </>
  );
}

/**
 * The invitations waiting for the person, whichever organization they are working in.
 *
 * One they accept leaves the server's list, so it is kept here as accepted until they leave the
 * page: the row is where the switch to the organization they just joined is offered.
 */
export function InvitationsPage() {
  const invitations = useQuery(receivedInvitationsQueryOptions());
  const [accepted, setAccepted] = useState<ReceivedInvitation[]>([]);
  const listed = invitations.data ?? [];
  const rows = [
    ...accepted.filter((one) => !listed.some((other) => other.id === one.id)),
    ...listed,
  ];

  return (
    <PageShell
      description="Accept an invitation to join an organization. You keep working where you are until you switch."
      title="Invitations"
    >
      {invitations.isPending ? null : invitations.error ? (
        <p className="text-destructive text-sm" role="alert">
          {failureSaid(invitations.error)}
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty icon={IconMail} title="No invitations">
          When somebody invites you to an organization, it shows here.
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((invitation, index) => (
            <Fragment key={invitation.id}>
              <InvitationRow
                invitation={invitation}
                onAccepted={(joined) =>
                  setAccepted((before) => [
                    joined,
                    ...before.filter((one) => one.id !== joined.id),
                  ])
                }
              />
              {index !== rows.length - 1 && <Separator />}
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageShell>
  );
}

/**
 * The page an invitation's link opens: that one invitation, in whatever state it is in. One the
 * server does not find for this person is said so, with the one thing to check.
 */
export function InvitationPage({ invitationId }: { invitationId: string }) {
  const invitation = useQuery(receivedInvitationQueryOptions(invitationId));

  return (
    <PageShell
      backButton={{ label: "Invitations", linkProps: { to: "/invitations" } }}
      title="Invitation"
    >
      {invitation.isPending ? null : invitation.error ? (
        <p className="text-destructive text-sm" role="alert">
          {failureSaid(invitation.error)}
        </p>
      ) : invitation.data === null ? (
        <PageEmpty icon={IconMailOff} title="Invitation not found">
          Check that you're signed in with the address it was sent to.
        </PageEmpty>
      ) : (
        <PageRows>
          <InvitationRow invitation={invitation.data} />
        </PageRows>
      )}
    </PageShell>
  );
}
