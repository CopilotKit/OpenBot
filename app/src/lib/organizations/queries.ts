import {
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import type {
  Invitation,
  Organization,
  OrganizationInvitation,
  OrganizationMember,
} from "@/lib/api/generated/model";
import {
  getInvitation,
  listInvitations,
  listOrganizationInvitations,
  listOrganizationMembers,
  listOrganizations,
} from "@/lib/api/generated/organizations/organizations";
import { renewalRequired } from "@/lib/auth/renewal";
import { ClientError, client } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  forgetDesktopOrganization,
  tellDesktopTheOrganization,
} from "@/lib/desktop/organization";
import { editionOf } from "@/lib/edition-guard";
import {
  currentOrganizationId,
  setCurrentOrganization,
  useCurrentOrganizationId,
} from "./current";
import { InNoOrganization } from "./in-no-organization";

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

/** One member of an organization, with the server's verdict: their role in it. */
export type OrganizationMemberSummary = OrganizationMember;

/** An invitation an organization sent, as its admins see it. `status` is the server's verdict. */
export type SentInvitation = OrganizationInvitation;

/** An invitation as the person it was sent to sees it. `status` is the server's verdict. */
export type ReceivedInvitation = Invitation;

/*
 * The same in every organization (query-client.ts), so a key about one organization names it: the
 * members of one are never drawn as another's.
 */
export const organizationKeys = {
  all: ["organizations"] as const,
  mine: () => ["organizations", "mine"] as const,
  members: (organizationId: string) =>
    ["organizations", "members", organizationId] as const,
  /** Whether anybody besides the person is a member: under `members`, so what refreshes them refreshes it. */
  others: (organizationId: string) =>
    ["organizations", "members", organizationId, "others"] as const,
  /** One search of the members, a page at a time: under `members`, so what refreshes them refreshes it. */
  memberPages: (organizationId: string, search = "") =>
    ["organizations", "members", organizationId, { search }] as const,
  sentInvitations: (organizationId: string) =>
    ["organizations", "sent-invitations", organizationId] as const,
  /** One search of the sent invitations, a page at a time, under `sentInvitations`. */
  sentInvitationPages: (organizationId: string, search = "") =>
    ["organizations", "sent-invitations", organizationId, { search }] as const,
  invitations: () => ["organizations", "invitations"] as const,
  invitation: (invitationId: string) =>
    ["organizations", "invitations", invitationId] as const,
};

/**
 * The one organization of an OpenBot that keeps one, which every install has. The API addresses it
 * as `default` (api/openapi.yaml, `OrganizationId`), and an API key made before keys were bound to
 * an organization acts in it.
 */
export const ONLY_ORGANIZATION = "default";
const ONLY: OwnOrganizations = {
  organizations: [],
  canCreate: false,
  currentId: ONLY_ORGANIZATION,
};

const LOAD_FALLBACK =
  "Couldn't load your organizations. Try again in a moment.";
export const SWITCH_FALLBACK = "Couldn't switch organizations. Try again.";
/**
 * Whether a failed read is an OpenBot that has no such address, which is how one that keeps one
 * organization answers the person's organizations and invitations: the address is not served, so it
 * is the API's plain not found (`NOT_FOUND`), or a 404 that names no code at all. Every other 404 is
 * a refusal and is said as one: `ORGANIZATION_NOT_FOUND` is the organization the request named not
 * being one of the person's, which an app's sign-in meets when it names an organization they are
 * not in (at the list of their own, OpenBot Desktop then names none: `ownOrganizations`). A 401 or
 * 403 is never this.
 */
function noSuchAddress(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    (error.code === undefined || error.code === "NOT_FOUND")
  );
}

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
  // Inside OpenBot Desktop connected to this OpenBot, the desktop app names it on every request.
  await tellDesktopTheOrganization(organizationId);
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
    // No OpenBot-Organization header: the page's own sign-in says which one is active, and where
    // an app's token signs it in, the app adds the header on its way to OpenBot.
    const page = await listOrganizations(
      { limit: 100, ...(cursor ? { cursor } : {}) },
      undefined,
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
    listed = await everyOrganization(signal).catch(async (error) => {
      /*
       * Inside OpenBot Desktop connected to this OpenBot, the desktop app names the organization the
       * person last worked in, kept through signing out and in again. One they have since left is
       * answered as not found: the desktop app is asked to name none, so the server works in their
       * own, and the list is read again. Once, and never an error screen for it.
       */
      if (
        error instanceof ClientError &&
        error.code === "ORGANIZATION_NOT_FOUND" &&
        (await forgetDesktopOrganization())
      )
        return everyOrganization(signal);
      throw error;
    });
  } catch (error) {
    // Not signed in is an answer, as it is for the current user.
    if (
      error instanceof ClientError &&
      error.status === 401 &&
      !renewalRequired(error)
    )
      return null;
    // An OpenBot that keeps one organization has no list of them. A refusal is not that.
    if (noSuchAddress(error)) return ONLY;
    throw error;
  }
  const { organizations } = listed;
  const active = organizations.find((one) => one.active);
  if (active) return { ...listed, currentId: active.id };
  const first = organizations[0];
  if (!first) throw new InNoOrganization();
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

/**
 * Whether the person has an organization to show: one to switch to, to open the settings of, or to
 * create. An OpenBot that lists none has none, and its account menu is as it always was.
 */
export function offersOrganizations(
  mine: OwnOrganizations | null | undefined,
): mine is OwnOrganizations {
  return !!mine && (mine.organizations.length > 0 || mine.canCreate);
}

/**
 * The person's organizations for the account menu and the organization screens, or undefined when
 * OpenBot lists none. The personal edition has one person and one organization, so it never asks.
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

const MEMBERS_FALLBACK = "Couldn't load the members. Try again in a moment.";
const SENT_INVITATIONS_FALLBACK =
  "Couldn't load the invitations. Try again in a moment.";
const INVITATIONS_FALLBACK =
  "Couldn't load your invitations. Try again in a moment.";
const INVITATION_FALLBACK =
  "Couldn't load that invitation. Try again in a moment.";

/** Every member of an organization, in the order they joined. Any member can read it. */
export function organizationMembersQueryOptions(organizationId: string) {
  return queryOptions({
    queryKey: organizationKeys.members(organizationId),
    queryFn: ({ signal }): Promise<OrganizationMemberSummary[]> =>
      everyPage(async (cursor) => {
        const page = await listOrganizationMembers(
          organizationId,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: MEMBERS_FALLBACK },
        );
        return { items: page.members, nextCursor: page.nextCursor };
      }),
  });
}

/**
 * Whether an organization has a member besides the person asking, who is one of them. The first two
 * members answer it, so a large organization is never read through.
 */
export function organizationHasOthersQueryOptions(organizationId: string) {
  return queryOptions({
    queryKey: organizationKeys.others(organizationId),
    queryFn: async ({ signal }): Promise<boolean> => {
      const page = await listOrganizationMembers(
        organizationId,
        { limit: 2 },
        { signal, fallback: MEMBERS_FALLBACK },
      );
      return page.members.length > 1 || page.nextCursor !== null;
    },
    staleTime: 60_000,
  });
}

/**
 * Who "everyone" is for a public Bot, as a screen says it: the organization by name where the app
 * knows it, and whether the person is its only member. `alone` is undefined until the members have
 * answered, and when they can't be read; a screen then says "everyone in the organization".
 */
export type OrganizationAudience = {
  organizationName: string | undefined;
  alone: boolean | undefined;
  /** Whether the members are still being read. */
  pending: boolean;
};

export function useOrganizationAudience(): OrganizationAudience {
  const team =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "team";
  const organizationName = useCurrentOrganizationName();
  const current = useCurrentOrganizationId();
  const others = useQuery({
    ...organizationHasOthersQueryOptions(current ?? ""),
    enabled: team && current !== undefined,
  });
  return {
    organizationName,
    alone: others.data === undefined ? undefined : !others.data,
    pending: team && current !== undefined && others.isPending,
  };
}

/** One page of an organization's members, and where the next one starts. */
export type OrganizationMemberPage = {
  members: OrganizationMemberSummary[];
  nextCursor: string | null;
};

/**
 * An organization's members, a page at a time, for Organization settings' Members list. With a
 * search, only those whose name or address holds it, best matches first: the server's search, so
 * somebody past the first page is found. A cursor belongs to the search that made it, which is why
 * each search is its own entry.
 */
export function organizationMemberPagesQueryOptions(
  organizationId: string,
  search = "",
) {
  return infiniteQueryOptions({
    queryKey: organizationKeys.memberPages(organizationId, search),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<OrganizationMemberPage> => {
      const page = await listOrganizationMembers(
        organizationId,
        {
          ...(search ? { search } : {}),
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        { signal, fallback: MEMBERS_FALLBACK },
      );
      return { members: page.members, nextCursor: page.nextCursor };
    },
    getNextPageParam: (page: OrganizationMemberPage) =>
      page.nextCursor ?? undefined,
  });
}

/** One page of the invitations an organization sent, and where the next one starts. */
export type SentInvitationPage = {
  invitations: SentInvitation[];
  nextCursor: string | null;
};

/**
 * The invitations an organization sent, a page at a time, the newest first. With a search, only
 * those whose address holds it. Only its owner and admins can read them.
 */
export function sentInvitationPagesQueryOptions(
  organizationId: string,
  search = "",
) {
  return infiniteQueryOptions({
    queryKey: organizationKeys.sentInvitationPages(organizationId, search),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<SentInvitationPage> => {
      const page = await listOrganizationInvitations(
        organizationId,
        {
          ...(search ? { search } : {}),
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        { signal, fallback: SENT_INVITATIONS_FALLBACK },
      );
      return { invitations: page.invitations, nextCursor: page.nextCursor };
    },
    getNextPageParam: (page: SentInvitationPage) =>
      page.nextCursor ?? undefined,
  });
}

/**
 * Every invitation an organization sent that is still waiting, expired or was declined, the newest
 * first. Only its owner and admins can read it; anybody else is refused in the server's sentence.
 */
export function sentInvitationsQueryOptions(organizationId: string) {
  return queryOptions({
    queryKey: organizationKeys.sentInvitations(organizationId),
    queryFn: ({ signal }): Promise<SentInvitation[]> =>
      everyPage(async (cursor) => {
        const page = await listOrganizationInvitations(
          organizationId,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: SENT_INVITATIONS_FALLBACK },
        );
        return { items: page.invitations, nextCursor: page.nextCursor };
      }),
  });
}

/**
 * Every invitation sent to the person's address that they have not answered, the newest first. One
 * that ran out of time is listed as expired. A refusal (a sign-in not allowed to see them, an
 * expired one, an organization the request named that is not the person's) fails in the server's
 * sentence: it is never "no invitations".
 */
export function receivedInvitationsQueryOptions() {
  return queryOptions({
    queryKey: organizationKeys.invitations(),
    queryFn: async ({ signal }): Promise<ReceivedInvitation[]> => {
      try {
        return await everyPage(async (cursor) => {
          const page = await listInvitations(
            { limit: 100, ...(cursor ? { cursor } : {}) },
            { signal, fallback: INVITATIONS_FALLBACK },
          );
          return { items: page.invitations, nextCursor: page.nextCursor };
        });
      } catch (error) {
        // An OpenBot that keeps one organization has no invitations to list, as it has no list of them.
        if (noSuchAddress(error)) return [];
        throw error;
      }
    },
    staleTime: 60_000,
    /*
     * Somebody invited, or who answered on the web, while OpenBot was open sees it when they come
     * back to the window: always, however lately it was read, so the count agrees with the web.
     */
    refetchOnWindowFocus: "always",
  });
}

/**
 * One invitation sent to the person's address, in whatever state it is in, for the page its link
 * opens. Null when there is none: it does not exist, or it was sent to another address.
 */
export function receivedInvitationQueryOptions(invitationId: string) {
  return queryOptions({
    queryKey: organizationKeys.invitation(invitationId),
    queryFn: async ({ signal }): Promise<ReceivedInvitation | null> => {
      try {
        return (
          await getInvitation(invitationId, {
            signal,
            fallback: INVITATION_FALLBACK,
          })
        ).invitation;
      } catch (error) {
        /*
         * Not found is an answer, which the page says in words: the invitation's own
         * (`INVITATION_NOT_FOUND`, api/openapi/organizations.yaml), or an OpenBot with no
         * invitations at all. Any other refusal is said as one.
         */
        if (
          (error instanceof ClientError &&
            error.code === "INVITATION_NOT_FOUND") ||
          noSuchAddress(error)
        )
          return null;
        throw error;
      }
    },
  });
}

/**
 * How many invitations are waiting for the person's answer, for the account menu. Zero where
 * OpenBot lists no organizations, which never asks. Null when they could not be read: how many is
 * not known, which is not none, and the invitations page says why.
 */
export function useWaitingInvitationCount(): number | null {
  const offered = useOrganizationChoices() !== undefined;
  const invitations = useQuery({
    ...receivedInvitationsQueryOptions(),
    enabled: offered,
  });
  if (!offered) return 0;
  if (invitations.isError) return null;
  return (
    invitations.data?.filter((invitation) => invitation.status === "pending")
      .length ?? 0
  );
}
