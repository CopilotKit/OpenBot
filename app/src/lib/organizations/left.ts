/**
 * Being removed from the organization the person is working in, while the app is open.
 *
 * Nothing tells the app at the moment it happens. The next request in that organization is refused:
 * at an address that names the organization, as one that does not exist (404
 * `ORGANIZATION_NOT_FOUND`), and at one the session decides, 403 in the server's sentence ("You're no
 * longer a member of the organization you were working in."). Either refusal makes the app read the
 * person's organizations again (query-client.ts). Should the one they work in be gone from the list,
 * the list itself moves them to one they are still in (`ownOrganizations` in ./queries.ts), the app
 * takes them home and changes over, as a switch made in another window is followed, and this notice
 * says why (`LeftOrganizationBanner`).
 *
 * Imports nothing but ./current.ts, so the query client can ask it.
 */
import { useSyncExternalStore } from "react";
import { onOrganizationChange } from "./current";

/** What the notice names: the organization left, and the one the person works in now. */
export type LeftOrganization = {
  /** Undefined when the list never named it. */
  leftName: string | undefined;
  nowId: string;
  nowName: string | undefined;
};

/**
 * Whether a refusal may mean the person is no longer a member of the organization the request was
 * in: an organization that is not found, or a 403 without a code, which is how the addresses the
 * session decides refuse it. Only a doubt: the list of their organizations says whether it is so.
 */
export function refusedInOrganization(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return (
    (status === 404 && code === "ORGANIZATION_NOT_FOUND") ||
    (status === 403 && code === undefined)
  );
}

let notice: LeftOrganization | undefined;
const listeners = new Set<() => void>();

function told() {
  for (const listener of [...listeners]) listener();
}

/** The person was moved off an organization they are no longer in. */
export function noteLeftOrganization(left: LeftOrganization): void {
  if (
    notice?.leftName === left.leftName &&
    notice?.nowId === left.nowId &&
    notice?.nowName === left.nowName
  )
    return;
  notice = left;
  told();
}

/** The notice is closed: dismissed, or the person moved on from where it took them. */
export function dismissLeftOrganization(): void {
  if (notice === undefined) return;
  notice = undefined;
  told();
}

// Moving on from the organization the notice took them to closes it: it is about that move only.
onOrganizationChange((_next, previous) => {
  if (notice !== undefined && previous === notice.nowId)
    dismissLeftOrganization();
});

/** The notice showing now, if any. */
export function leftOrganization(): LeftOrganization | undefined {
  return notice;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The notice for a component, which redraws when it opens or closes. */
export function useLeftOrganization(): LeftOrganization | undefined {
  return useSyncExternalStore(subscribe, leftOrganization, leftOrganization);
}

/** What the notice says. */
export function leftOrganizationSaid(left: LeftOrganization): string {
  const gone = left.leftName
    ? `You're no longer a member of ${left.leftName}.`
    : "You're no longer a member of the organization you were working in.";
  return left.nowName ? `${gone} You're now working in ${left.nowName}.` : gone;
}
