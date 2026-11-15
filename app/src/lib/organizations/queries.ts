import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { Organization } from "@/lib/api/generated/model";
import { listOrganizations } from "@/lib/api/generated/organizations/organizations";
import { ClientError, client } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { editionOf } from "@/lib/edition-guard";
import { currentOrganizationId, setCurrentOrganization } from "./current";

/** One of the person's organizations, with the server's verdicts: their role in it, and `active`. */
export type OrganizationSummary = Organization;

/** The person's organizations, and the one they are working in. */
export type OwnOrganizations = {
  /** The one they joined first at the top. Empty where OpenBot keeps one organization and lists none. */
  organizations: OrganizationSummary[];
  /** The server's verdict: whether this person may create an organization. */
  canCreate: boolean;
  /** The id of the one they are working in, which every request is addressed to. */
  currentId: string;
};

export const organizationKeys = {
  all: ["organizations"] as const,
  mine: () => ["organizations", "mine"] as const,
};

/**
 * The one organization of an OpenBot that keeps one. The API addresses it as `default`
 * (api/openapi.yaml, `OrganizationId`).
 */
const ONLY_ORGANIZATION = "default";
const ONLY: OwnOrganizations = {
  organizations: [],
  canCreate: false,
  currentId: ONLY_ORGANIZATION,
};

const LOAD_FALLBACK = "Couldn't load your organizations. Reload the page.";
export const SWITCH_FALLBACK = "Couldn't switch organizations. Try again.";
/** What the server says on every other request to somebody in no organization, said here too. */
const IN_NONE =
  "You aren't a member of an organization here. Ask an admin to add you.";

/**
 * Work in `organizationId` from the server's side: the session's active organization, which is what
 * every address outside the API reads and writes in. The server refuses one the person is not in.
 * A step of reading and of switching, so a plain function and not a mutation of its own.
 */
export async function workIn(organizationId: string): Promise<void> {
  await client("/api/auth/organization/set-active", {
    method: "POST",
    body: { organizationId },
    fallback: SWITCH_FALLBACK,
  });
}

/** Every organization the person is in, page by page, and whether they may create one. */
async function everyOrganization(
  signal: AbortSignal,
): Promise<Pick<OwnOrganizations, "organizations" | "canCreate">> {
  const organizations: OrganizationSummary[] = [];
  const seen = new Set<string>();
  let canCreate = false;
  let cursor: string | undefined;
  do {
    const page = await listOrganizations(
      { limit: 100, ...(cursor ? { cursor } : {}) },
      { signal, fallback: LOAD_FALLBACK },
    );
    organizations.push(...page.organizations);
    canCreate = page.canCreate === true;
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return { organizations, canCreate };
}

async function ownOrganizations(
  queryClient: QueryClient,
  signal: AbortSignal,
): Promise<OwnOrganizations | null> {
  // One person, no sign-in, one organization: there is no list to ask for.
  if ((await editionOf(queryClient)) === "personal") return ONLY;
  let listed: Pick<OwnOrganizations, "organizations" | "canCreate">;
  try {
    listed = await everyOrganization(signal);
  } catch (error) {
    // Not signed in is an answer, as it is for the current user.
    if (error instanceof ClientError && error.status === 401) return null;
    // An OpenBot that keeps one organization has no list of them.
    if (error instanceof ClientError && error.status === 404) return ONLY;
    throw error;
  }
  const { organizations } = listed;
  const active = organizations.find((one) => one.active);
  if (active) return { ...listed, currentId: active.id };
  const first = organizations[0];
  if (!first) throw new Error(IN_NONE);
  /*
   * In some, working in none: the session still names one this person has left. The rest of
   * OpenBot refuses every request until the session works somewhere they are, so it moves to the
   * one they joined first before anything else is asked.
   */
  await workIn(first.id);
  return {
    ...listed,
    organizations: organizations.map((one) => ({
      ...one,
      active: one.id === first.id,
    })),
    currentId: first.id,
  };
}

/** How the person is taken off the screen they are on when a switch made elsewhere is followed. */
let leaveForSwitchElsewhere: (() => Promise<void>) | undefined;

/**
 * Say how to leave the open screen when the session turns out to be working in another
 * organization: a switch made in another window. The app's layout takes the person home, as a
 * switch made here does. Returns how to stop.
 */
export function onSwitchedElsewhere(leave: () => Promise<void>): () => void {
  leaveForSwitchElsewhere = leave;
  return () => {
    if (leaveForSwitchElsewhere === leave) leaveForSwitchElsewhere = undefined;
  };
}

/**
 * Follow a switch the person made in another window: this window goes home, then changes over, so
 * the conversation or Bot open here is never asked for in an organization it is not in.
 *
 * After the answer that found it out has been kept, not while it is being read: changing over
 * takes every screen off the page, and a read that nobody on the page is waiting for is thrown
 * away, which left the account row naming the organization the window had just left.
 */
async function follow(
  queryClient: QueryClient,
  from: string,
  to: string,
): Promise<void> {
  await new Promise((kept) => setTimeout(kept, 0));
  const still = () =>
    currentOrganizationId() === from &&
    queryClient.getQueryData<OwnOrganizations | null>(organizationKeys.mine())
      ?.currentId === to;
  if (!still()) return;
  await leaveForSwitchElsewhere?.();
  // Unless the person switched here meanwhile, or the list has since said otherwise.
  if (still()) setCurrentOrganization(to);
}

/**
 * The signed-in person's organizations, or null when nobody is signed in.
 *
 * Reading it is what tells the app which organization it is working in (./current.ts): the answer
 * is put there before it is returned, so nothing that waits for this can ask in another one.
 */
export function ownOrganizationsQueryOptions() {
  return queryOptions({
    queryKey: organizationKeys.mine(),
    queryFn: async ({ client: queryClient, signal }) => {
      const mine = await ownOrganizations(queryClient, signal);
      /*
       * Not from an answer nobody is waiting for any more (a switch overtook it), and not from
       * "nobody is signed in": a session that lapsed leaves the app where it was until the person
       * signs in again, which loads the page afresh.
       */
      if (!mine || signal.aborted) return mine;
      const known = currentOrganizationId();
      if (known !== undefined && known !== mine.currentId) {
        // The session works in another organization than this window does: see `follow`.
        void follow(queryClient, known, mine.currentId);
        return mine;
      }
      setCurrentOrganization(mine.currentId);
      return mine;
    },
    staleTime: 60_000,
    /*
     * A switch made in another window is noticed when the person comes back to this one. Always,
     * however lately the list was read: the session is one for every window, so until this is
     * asked the window would go on naming the organization it left while every address the
     * session decides answered from the other.
     */
    refetchOnWindowFocus: "always",
  });
}

/**
 * The organization the app is working in, read from the server when it is not known yet. Undefined
 * when nobody is signed in.
 */
export async function ensureCurrentOrganization(
  queryClient: QueryClient,
): Promise<string | undefined> {
  const known = currentOrganizationId();
  if (known !== undefined) return known;
  return (await queryClient.fetchQuery(ownOrganizationsQueryOptions()))
    ?.currentId;
}

/**
 * The name of the organization the person is working in, for a page that says whose something is.
 * Undefined until the list has answered, and where OpenBot keeps one organization and lists none.
 */
export function useCurrentOrganizationName(): string | undefined {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const mine = useQuery({
    ...ownOrganizationsQueryOptions(),
    enabled: capabilities.data?.edition === "team",
  });
  return mine.data?.organizations.find((one) => one.id === mine.data?.currentId)
    ?.name;
}

/** Whether there is anything to switch to or create: otherwise the account menu is as it always was. */
export function offersOrganizations(
  mine: OwnOrganizations | null | undefined,
): mine is OwnOrganizations {
  return !!mine && (mine.organizations.length > 1 || mine.canCreate);
}

/**
 * The person's organizations for the account menu, or undefined when there is nothing to switch to
 * or create. The personal edition has one person and one organization, so it never asks.
 */
export function useOrganizationChoices(): OwnOrganizations | undefined {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const mine = useQuery({
    ...ownOrganizationsQueryOptions(),
    enabled: capabilities.data?.edition === "team",
  });
  return capabilities.data?.edition === "team" && offersOrganizations(mine.data)
    ? mine.data
    : undefined;
}
