import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import type {
  OrganizationMember,
  Team,
  TeamMember,
  TeamModels,
} from "@/lib/api/generated/model";
import { listOrganizationMembers } from "@/lib/api/generated/organizations/organizations";
import {
  getTeam,
  getTeamModels,
  listTeamMembers,
  listTeams,
} from "@/lib/api/generated/teams/teams";
import { organizationId } from "@/lib/api/request";

/**
 * One team of the organization the person is working in: the API's `Team`. `role` is their own role
 * in it (null when they are not in it). `canManage`, `canMove` and `canDelete` are the server's
 * verdicts on whether they may rename it and add and remove its people, change the team it is
 * under, and delete it; the screens draw these and work none of them out. A team whose `source` is
 * `directory` takes its name and its people from the company's directory.
 */
export type TeamSummary = Team;

/** One person in a team: the API's `TeamMember`. `isCaller` marks the person who is asking. */
export type TeamPerson = TeamMember;

/** One member of the organization, for choosing who to add to a team. */
export type OrganizationPerson = OrganizationMember;

/**
 * The models a team's people may run: the API's `TeamModels`. `models` is null when the team sets
 * none, so its people run whatever the organization allows; otherwise each is `provider/model`, and
 * one the organization no longer allows stays listed and lets nobody run it.
 */
export type TeamModelList = TeamModels;

/** The organization's teams, and the server's verdict on whether this person may create one. */
export type TeamList = {
  /** In the order they were created. */
  teams: TeamSummary[];
  /**
   * Whether this person may create a team: the server's verdict, and read for nothing else. What
   * they may do to a team that exists is on the team.
   */
  canCreate: boolean;
};

/**
 * Rooted at `teams`, never at `organizations`: the query client keeps what is rooted there for every
 * organization (query-client.ts), and a team belongs to one. The organization's members are kept
 * here for the same reason.
 */
export const teamKeys = {
  all: ["teams"] as const,
  list: () => ["teams", "list"] as const,
  /** One search of the teams, a page at a time: under `list`, so what refreshes it refreshes this. */
  listPages: (search = "") => ["teams", "list", { search }] as const,
  detail: (teamId: string) => ["teams", "detail", teamId] as const,
  members: (teamId: string) => ["teams", "members", teamId] as const,
  models: (teamId: string) => ["teams", "models", teamId] as const,
  /** One search of a team's people, a page at a time, under `members`. */
  memberPages: (teamId: string, search = "") =>
    ["teams", "members", teamId, { search }] as const,
  /** Who of the people matching a search for somebody to add is in the team already. */
  memberMatches: (teamId: string, search: string) =>
    ["teams", "members", teamId, "matches", { search }] as const,
  /** The organization's members matching what was typed, keyed by it as sent. */
  peopleSearch: (search: string) => ["teams", "people", { search }] as const,
};

const FALLBACK = "Couldn't load teams. Try again in a moment.";

/** The value a Bot's assignment carries for a team: `team:<id>`, beside a directory group's name. */
const TEAM_VALUE = "team:";

/** What a Bot is assigned to when it is assigned to this team. */
export function teamValue(teamId: string): string {
  return `${TEAM_VALUE}${teamId}`;
}

/** The team an assignment names, or null when it names a directory group or everybody. */
export function teamOfValue(value: string): string | null {
  return value.startsWith(TEAM_VALUE) ? value.slice(TEAM_VALUE.length) : null;
}

/** Every team of the organization, page by page to the end. */
export function teamListQueryOptions() {
  return queryOptions({
    queryKey: teamKeys.list(),
    queryFn: async ({ signal }): Promise<TeamList> => {
      let canCreate = false;
      const teams = await everyPage(async (cursor) => {
        const page = await listTeams(
          organizationId(),
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: FALLBACK },
        );
        canCreate = page.canCreate;
        return { items: page.teams, nextCursor: page.nextCursor };
      });
      return { teams, canCreate };
    },
  });
}

/** One page of the organization's teams, where the next one starts, and whether a team may be created. */
export type TeamListPage = TeamList & { nextCursor: string | null };

/**
 * The organization's teams, a page at a time, for the Teams list. With a search, only the teams
 * whose name holds it: the server's search, so a team past the first page is found. Pickers that
 * choose a team keep reading every team (teamListQueryOptions).
 */
export function teamListPagesQueryOptions(search = "") {
  return infiniteQueryOptions({
    queryKey: teamKeys.listPages(search),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<TeamListPage> => {
      const page = await listTeams(
        organizationId(),
        {
          ...(search ? { search } : {}),
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        { signal, fallback: FALLBACK },
      );
      return {
        teams: page.teams,
        canCreate: page.canCreate,
        nextCursor: page.nextCursor,
      };
    },
    getNextPageParam: (page: TeamListPage) => page.nextCursor ?? undefined,
  });
}

export function teamQueryOptions(teamId: string) {
  return queryOptions({
    queryKey: teamKeys.detail(teamId),
    queryFn: async ({ signal }): Promise<TeamSummary> =>
      (await getTeam(organizationId(), teamId, { signal, fallback: FALLBACK }))
        .team,
  });
}

/** The people in the team itself, in the order they joined it. */
export function teamMembersQueryOptions(teamId: string) {
  return queryOptions({
    queryKey: teamKeys.members(teamId),
    queryFn: ({ signal }): Promise<TeamPerson[]> =>
      everyPage(async (cursor) => {
        const page = await listTeamMembers(
          organizationId(),
          teamId,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: FALLBACK },
        );
        return { items: page.members, nextCursor: page.nextCursor };
      }),
  });
}

/** The models the team's people may run, or null models when it sets none. Anybody may read it. */
export function teamModelsQueryOptions(teamId: string) {
  return queryOptions({
    queryKey: teamKeys.models(teamId),
    queryFn: ({ signal }): Promise<TeamModelList> =>
      getTeamModels(organizationId(), teamId, {
        signal,
        fallback: "Couldn't load this team's models. Try again in a moment.",
      }),
  });
}

/** One page of a team's people, and where the next one starts. */
export type TeamPeoplePage = {
  members: TeamPerson[];
  nextCursor: string | null;
};

/**
 * The people in a team, a page at a time, in the order they joined it. With a search, only those
 * whose name or address holds it: the server's search, so somebody past the first page is found.
 */
export function teamMemberPagesQueryOptions(teamId: string, search = "") {
  return infiniteQueryOptions({
    queryKey: teamKeys.memberPages(teamId, search),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<TeamPeoplePage> => {
      const page = await listTeamMembers(
        organizationId(),
        teamId,
        {
          ...(search ? { search } : {}),
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        { signal, fallback: FALLBACK },
      );
      return { members: page.members, nextCursor: page.nextCursor };
    },
    getNextPageParam: (page: TeamPeoplePage) => page.nextCursor ?? undefined,
  });
}

/**
 * Who in a team matches what was typed when adding somebody to it, by id: the team's own search
 * with the same words, so the people the organization's search offers can be marked as in the team
 * already. One page of the most the API gives (100). Choosing somebody checks again on its own
 * (isInTeam), so a team bigger than that page never has a maintainer added over as a member.
 */
export function teamMemberMatchesQueryOptions(teamId: string, search: string) {
  return queryOptions({
    queryKey: teamKeys.memberMatches(teamId, search),
    queryFn: async ({ signal }): Promise<ReadonlySet<string>> => {
      const page = await listTeamMembers(
        organizationId(),
        teamId,
        { search, limit: 100 },
        { signal, fallback: SEARCH_FALLBACK },
      );
      return new Set(page.members.map((member) => member.id));
    },
    staleTime: 30_000,
  });
}

/**
 * Whether somebody chosen to add is in the team already, asked of the server just before they are
 * added: adding is a PUT of their role, which would make a maintainer a member again.
 */
export async function isInTeam(
  teamId: string,
  person: OrganizationPerson,
): Promise<boolean> {
  const search = person.email.trim() || person.name?.trim();
  // Somebody with neither has nothing to find them by, and nobody in a team has neither.
  if (!search) return false;
  for (let cursor: string | undefined, seen = 0; seen < 20; seen += 1) {
    const page = await listTeamMembers(
      organizationId(),
      teamId,
      { search, limit: 100, ...(cursor ? { cursor } : {}) },
      { fallback: SEARCH_FALLBACK },
    );
    if (page.members.some((member) => member.id === person.id)) return true;
    if (!page.nextCursor) return false;
    cursor = page.nextCursor;
  }
  return false;
}

/** How many people a search for somebody to add offers at once: enough to choose from, few enough to read. */
export const PEOPLE_OFFERED = 8;

const SEARCH_FALLBACK = "Couldn't search people. Try again in a moment.";

/** What a search for somebody to add is sent as: what was typed, without spaces around it or case. */
export function peopleSearchText(typed: string): string {
  return typed.trim().toLowerCase();
}

/**
 * The members of the organization whose name or address matches what somebody typed, best matches
 * first: the server's search (listOrganizationMembers with search), which finds only this
 * organization's current members. One page of {@link PEOPLE_OFFERED}, for choosing who to add to a
 * team. A search that is typed past is cancelled, through the signal, before its answer arrives.
 */
export function peopleSearchQueryOptions(search: string) {
  return queryOptions({
    queryKey: teamKeys.peopleSearch(search),
    queryFn: async ({ signal }): Promise<OrganizationPerson[]> =>
      (
        await listOrganizationMembers(
          organizationId(),
          { search, limit: PEOPLE_OFFERED },
          { signal, fallback: SEARCH_FALLBACK },
        )
      ).members,
    // What somebody types again a moment later is answered from what was found.
    staleTime: 30_000,
  });
}

/**
 * The teams this one may be put under: never itself, never a team under it (at any depth), and
 * never a team from the company's directory, which cannot be a parent. The server refuses each of
 * these too; leaving them out is so the screen does not offer what it knows will be refused.
 */
export function possibleParents(
  teams: readonly TeamSummary[],
  teamId?: string,
): TeamSummary[] {
  const under = new Set<string>();
  if (teamId !== undefined) {
    under.add(teamId);
    // Each pass takes in the teams one level further down, until a pass finds none.
    for (let found = true; found; ) {
      found = false;
      for (const team of teams) {
        if (
          team.parentTeamId !== null &&
          under.has(team.parentTeamId) &&
          !under.has(team.id)
        ) {
          under.add(team.id);
          found = true;
        }
      }
    }
  }
  return teams.filter(
    (team) => team.source !== "directory" && !under.has(team.id),
  );
}
