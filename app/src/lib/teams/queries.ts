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
 * in it (null when they are not in it) and `canManage` is the server's verdict on whether they may
 * rename it and add and remove its people. A team whose `source` is `directory` takes its name and
 * its people from the company's directory, so nothing about it is changed here.
 */
export type TeamSummary = Team;

/** One person in a team: the API's `TeamMember`. */
export type TeamPerson = TeamMember;

/** One member of the organization, for choosing who to add to a team. */
export type OrganizationPerson = OrganizationMember;

/** The organization's teams, and the server's verdict on whether this person may create one. */
export type TeamList = {
  /** In the order they were created. */
  teams: TeamSummary[];
  /**
   * Whether this person may create a team: the server's verdict. Only an owner or an admin of the
   * organization may, and the same people are the ones who may delete a team or move it under
   * another, so the screens read this for those too.
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
  people: () => ["teams", "people"] as const,
};

const FALLBACK = "Couldn't load teams. Reload the page.";

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

/** Every member of the organization, to choose from when adding somebody to a team. */
export function organizationPeopleQueryOptions() {
  return queryOptions({
    queryKey: teamKeys.people(),
    queryFn: ({ signal }): Promise<OrganizationPerson[]> =>
      everyPage(async (cursor) => {
        const page = await listOrganizationMembers(
          organizationId(),
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: FALLBACK },
        );
        return { items: page.members, nextCursor: page.nextCursor };
      }),
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
