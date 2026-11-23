import { queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import type {
  OrganizationMember,
  Team,
  TeamMember,
} from "@/lib/api/generated/model";
import { listOrganizationMembers } from "@/lib/api/generated/organizations/organizations";
import {
  getTeam,
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
  detail: (teamId: string) => ["teams", "detail", teamId] as const,
  members: (teamId: string) => ["teams", "members", teamId] as const,
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
