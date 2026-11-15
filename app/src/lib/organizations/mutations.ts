import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  AssignableRole,
  OrganizationInvitationResponse,
} from "@/lib/api/generated/model";
import {
  acceptInvitation,
  cancelOrganizationInvitation,
  createOrganization,
  createOrganizationInvitation,
  declineInvitation,
  removeOrganizationMember,
  updateOrganization,
} from "@/lib/api/generated/organizations/organizations";
import { idempotencyKey } from "@/lib/api/request";
import { currentOrganizationId, setCurrentOrganization } from "./current";
import {
  type OrganizationSummary,
  type OwnOrganizations,
  organizationKeys,
  workIn,
} from "./queries";

const CREATE_FALLBACK = "Couldn't create the organization. Try again.";
const RENAME_FALLBACK = "Couldn't rename the organization. Try again.";
const INVITE_FALLBACK = "Couldn't send the invitation. Try again.";
const CANCEL_FALLBACK = "Couldn't cancel the invitation. Try again.";
const REMOVE_FALLBACK = "Couldn't remove them. Try again.";
const LEAVE_FALLBACK = "Couldn't leave the organization. Try again.";
const ACCEPT_FALLBACK = "Couldn't accept the invitation. Try again.";
const DECLINE_FALLBACK = "Couldn't decline the invitation. Try again.";

/** Everything read about organizations is read again: the list, members and invitations alike. */
function invalidateOrganizations(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: organizationKeys.all });
}

/**
 * Work in another of the person's organizations.
 *
 * The server moves the session first, and refuses an organization the person is not in. Then
 * `leave` runs (the caller takes the person home, so no screen of the organization being left is
 * drawn again for the new one), and only then does the app change over: everything it held for the
 * old organization is dropped (query-client.ts) and every screen is drawn again from the new one.
 */
export function switchOrganizationMutationOptions(
  queryClient: QueryClient,
  leave: () => Promise<void> = async () => {},
) {
  return mutationOptions({
    mutationFn: (organizationId: string) => workIn(organizationId),
    onSuccess: async (_done, organizationId) => {
      await leave();
      setCurrentOrganization(organizationId);
      await invalidateOrganizations(queryClient);
    },
  });
}

/**
 * Create an organization, owned by the person who asked. A refusal is the server's own sentence.
 * The person keeps working where they were: switching to the new one is the caller's next step.
 */
export function createOrganizationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string): Promise<OrganizationSummary> =>
      (
        await createOrganization(
          { name },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: CREATE_FALLBACK },
        )
      ).organization,
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}

/** Give an organization a new name. Only its owner and admins can; anybody else is refused in words. */
export function renameOrganizationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      organizationId: string;
      name: string;
    }): Promise<OrganizationSummary> =>
      (
        await updateOrganization(
          variables.organizationId,
          { name: variables.name },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: RENAME_FALLBACK },
        )
      ).organization,
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}

/**
 * Invite the person with an address to an organization, with a role. The answer says how they hear
 * of it: `emailed`, or `link` when the inviter passes the invitation's link on themselves.
 */
export function inviteToOrganizationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      organizationId: string;
      email: string;
      role: AssignableRole;
    }): Promise<OrganizationInvitationResponse> =>
      createOrganizationInvitation(
        variables.organizationId,
        { email: variables.email, role: variables.role },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: INVITE_FALLBACK },
      ),
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}

/** Take back an invitation an organization sent, whatever state it is in. */
export function cancelSentInvitationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      organizationId: string;
      invitationId: string;
    }): Promise<void> =>
      cancelOrganizationInvitation(
        variables.organizationId,
        variables.invitationId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: CANCEL_FALLBACK },
      ),
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}

/** End somebody's membership of an organization. The server refuses removing its owner, in words. */
export function removeOrganizationMemberMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: {
      organizationId: string;
      personId: string;
    }): Promise<void> =>
      removeOrganizationMember(
        variables.organizationId,
        variables.personId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: REMOVE_FALLBACK },
      ),
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}

/**
 * Leave an organization, as the person signed in.
 *
 * Somebody who leaves the one they are working in is moved to another of theirs the way a switch
 * moves them: the session first, then `leave` (the caller takes them home), then the app changes
 * over. Nothing is read again before that, so no screen asks the organization just left for
 * anything. Should the session not move, the list of their organizations moves it when it is read
 * (./queries.ts).
 */
export function leaveOrganizationMutationOptions(
  queryClient: QueryClient,
  leave: () => Promise<void> = async () => {},
) {
  return mutationOptions({
    mutationFn: (organizationId: string): Promise<void> =>
      removeOrganizationMember(
        organizationId,
        "me",
        { "Idempotency-Key": idempotencyKey() },
        { fallback: LEAVE_FALLBACK },
      ),
    onSuccess: async (_done, organizationId) => {
      const next = queryClient
        .getQueryData<OwnOrganizations | null>(organizationKeys.mine())
        ?.organizations.find((one) => one.id !== organizationId);
      if (next && currentOrganizationId() === organizationId) {
        const moved = await workIn(next.id).then(
          () => true,
          () => false,
        );
        if (moved) {
          await leave();
          setCurrentOrganization(next.id);
        }
      }
      await invalidateOrganizations(queryClient);
    },
  });
}

/**
 * Join the organization an invitation is for. The person keeps working where they were: switching
 * to it is the caller's next step. One that expired, was canceled or was already answered is
 * refused in the server's sentence.
 */
export function acceptInvitationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (invitationId: string): Promise<OrganizationSummary> =>
      (
        await acceptInvitation(
          invitationId,
          { "Idempotency-Key": idempotencyKey() },
          { fallback: ACCEPT_FALLBACK },
        )
      ).organization,
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}

/** Turn an invitation down. It leaves the person's list. */
export function declineInvitationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (invitationId: string): Promise<void> =>
      declineInvitation(
        invitationId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: DECLINE_FALLBACK },
      ),
    onSuccess: () => invalidateOrganizations(queryClient),
  });
}
