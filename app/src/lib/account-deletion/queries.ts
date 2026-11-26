import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type {
  AccountDeletion,
  AccountDeletionBlocker,
} from "@/lib/api/generated/model";
import { getAccountDeletion } from "@/lib/api/generated/people/people";
import { ClientError } from "@/lib/client";
import {
  type DeploymentCapabilities,
  deploymentCapabilitiesQueryOptions,
} from "@/lib/deployment/queries";

/**
 * Where deleting the person's own account stands (getAccountDeletion, api/openapi/accounts.yaml):
 * whether a deletion is scheduled and when, and the organizations that stop it now (`blockers`,
 * the server's verdict). The account is the person's, not an organization's, so the answer is the
 * same whichever organization they work in (query-client.ts keeps it under no organization).
 */
export type { AccountDeletion, AccountDeletionBlocker };

export const accountDeletionKeys = {
  all: ["account-deletion"] as const,
  mine: ["account-deletion", "mine"] as const,
};

/** The words the person types to confirm, as the API checks them. */
export const DELETE_PHRASE = "delete my account";

/** How many days a scheduled deletion waits, as the API schedules it. */
export const DELETION_WAIT_DAYS = 14;

export {
  ACCOUNT_PENDING_DELETION,
  pendingDeletionRefusal,
} from "./pending";

/** The API's code for a session that has to sign in again before it may delete the account. */
export const REAUTHENTICATE = "REAUTHENTICATE";

/** The API's code for a deletion an organization blocks; the problem carries `blockers`. */
export const ACCOUNT_DELETION_BLOCKED = "ACCOUNT_DELETION_BLOCKED";

/** Whether a refusal says the session has to sign in again first. */
export function reauthenticationRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === REAUTHENTICATE
  );
}

/**
 * Whether a failed read is an OpenBot older than this operation: the address is not served, so it
 * is the API's plain not found, or a 404 that names no code. There is nothing to show then.
 */
export function olderOpenBot(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    (error.code === undefined || error.code === "NOT_FOUND")
  );
}

/**
 * Whether this OpenBot deletes accounts at all. NOT IN THE PERSONAL EDITION: its one person is the
 * install's own (single-user mode), with no account to delete, and the server doesn't serve the
 * question there, so nothing asks it. An edition that could not be read is the team edition, as
 * everywhere else.
 */
export function offersAccountDeletion(
  capabilities: Pick<DeploymentCapabilities, "edition"> | undefined,
): boolean {
  return capabilities?.edition !== "personal";
}

/** The person's own account deletion. */
export function accountDeletionQueryOptions() {
  return queryOptions({
    queryKey: accountDeletionKeys.mine,
    queryFn: ({ signal }): Promise<AccountDeletion> =>
      getAccountDeletion({
        signal,
        fallback: "Couldn't check whether your account can be deleted.",
      }),
  });
}

/**
 * The date a scheduled deletion happens, for the signed-in gate: undefined when nothing is
 * scheduled. A read that fails says nothing about a deletion (an OpenBot older than the question,
 * or one that couldn't answer), so it lets the person in: a session whose account is scheduled is
 * refused everywhere else anyway, and that refusal shows the pending page. In the personal edition
 * nothing is asked ({@link offersAccountDeletion}).
 */
export async function scheduledDeletion(
  queryClient: QueryClient,
): Promise<AccountDeletion | undefined> {
  const capabilities = await queryClient
    .ensureQueryData(deploymentCapabilitiesQueryOptions())
    .catch(() => undefined);
  if (!offersAccountDeletion(capabilities)) return undefined;
  try {
    // Asked once: the app waits on it, and a failure lets the person in anyway.
    const deletion = await queryClient.ensureQueryData({
      ...accountDeletionQueryOptions(),
      retry: false,
    });
    return deletion.status === "scheduled" ? deletion : undefined;
  } catch {
    return undefined;
  }
}

const LONG_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

/** The day a deletion happens, as a person reads a date: "December 9, 2026". */
export function deletionDay(deleteAfter: string): string | undefined {
  const at = new Date(deleteAfter);
  return Number.isNaN(at.getTime()) ? undefined : LONG_DATE.format(at);
}

/** Whether what was typed is the person's email address, as the API matches it. */
export function sameEmail(typed: string, email: string | undefined): boolean {
  return !!email && typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/** Whether what was typed is the phrase, as the API matches it. */
export function samePhrase(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETE_PHRASE;
}

/**
 * What a blocker asks of the person, in their words. A reason this app doesn't know is read as
 * having to leave, as the API says to read it.
 */
export function blockerWords(blocker: AccountDeletionBlocker): string {
  if (blocker.reason === "only_owner")
    return "You're its only owner: make someone else an owner, or delete the organization.";
  if (blocker.reason === "only_admin")
    return "You're its only admin: make someone else an admin.";
  return "Leave this organization first.";
}

/**
 * Whether what a blocker asks is done in the organization's own settings (making someone else an
 * owner or an admin, or deleting it) rather than by leaving it here.
 */
export function settledInItsSettings(blocker: AccountDeletionBlocker): boolean {
  return blocker.reason === "only_owner" || blocker.reason === "only_admin";
}
