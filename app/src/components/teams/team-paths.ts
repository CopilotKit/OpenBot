import { linkOptions } from "@tanstack/react-router";

/** The frame the team pages are drawn in: the app's, or Admin's. */
export type TeamsShell = "app" | "admin";

/**
 * Where the team pages link to, given the frame they are in. Everybody opens Teams in the app at
 * `/teams`; an admin also opens the same pages inside Admin at `/admin/teams`. Every link between
 * them (a team, New team, back to the list, after a create or a delete) goes through here, so a
 * page opened in Admin stays in Admin and one opened in the app stays in the app.
 */
export function teamPaths(shell: TeamsShell) {
  if (shell === "admin") {
    return {
      list: () => linkOptions({ to: "/admin/teams" }),
      newTeam: () => linkOptions({ to: "/admin/teams/new" }),
      team: (teamId: string) =>
        linkOptions({ to: "/admin/teams/$teamId", params: { teamId } }),
    };
  }
  return {
    list: () => linkOptions({ to: "/teams" }),
    newTeam: () => linkOptions({ to: "/teams/new" }),
    team: (teamId: string) =>
      linkOptions({ to: "/teams/$teamId", params: { teamId } }),
  };
}

export type TeamPaths = ReturnType<typeof teamPaths>;

/** The back button on a team's page and on New team: to the list, in the same frame. */
export function backToTeams(paths: TeamPaths) {
  return { label: "Teams", linkProps: paths.list() };
}
