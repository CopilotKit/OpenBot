import {
  IconBuildingBank,
  IconChevronRight,
  IconPlus,
  IconSearch,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TeamPage } from "@/components/edition/for-a-team";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { SEARCH_MAX } from "@/lib/people/queries";
import {
  type TeamSummary,
  teamListPagesQueryOptions,
  teamQueryOptions,
} from "@/lib/teams/queries";
import { type TeamPaths, type TeamsShell, teamPaths } from "./team-paths";
import { TEAMS_DESCRIPTION, teamFacts } from "./team-words";
import { failureSaid } from "@/lib/load-failure";

/**
 * The organization's teams: each one's name, what it is for, how many people are in it, whether it
 * comes from the company's directory, and the reader's own role in it. A page at a time, with a
 * search above them that asks the server, as Admin's People does. A team opens to its page; New
 * team is its own screen, offered only to whoever the server lets create one.
 */
function Teams({ paths }: { paths: TeamPaths }) {
  const [search, setSearch] = useState("");
  // Debounced, so typing a name is one request rather than one per keystroke.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useInfiniteQuery(teamListPagesQueryOptions(query));
  const teams = list.data?.pages.flatMap((page) => page.teams) ?? [];
  const canCreate = list.data?.pages[0]?.canCreate === true;

  const newTeam = (variant: "ghost" | "outline") => (
    <Button
      render={(props) => <Link {...props} {...paths.newTeam()} />}
      size="sm"
      variant={variant}
    >
      <IconPlus />
      New team
    </Button>
  );

  return (
    <PageShell
      action={canCreate ? newTeam("ghost") : undefined}
      description={TEAMS_DESCRIPTION}
      title="Teams"
    >
      {/*
       * One list, so no section and no second heading: the page's title already names it, and the
       * frame puts whatever comes first 32px under the title block.
       */}
      {/*
        Server-side search, as on Admin's People: filtering what already arrived would only search
        the first page. Shown once there is a team to search, or something typed.
      */}
      {search || query || teams.length > 0 ? (
        <Input
          aria-label="Search teams"
          maxLength={SEARCH_MAX}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name"
          value={search}
        />
      ) : null}
      {list.isPending ? null : list.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(list.error)}
        </p>
      ) : teams.length === 0 && query ? (
        <PageEmpty icon={IconSearch} title="No matches">
          {`No team matches "${query}".`}
        </PageEmpty>
      ) : teams.length === 0 ? (
        <PageEmpty
          action={canCreate ? newTeam("outline") : undefined}
          icon={IconUsersGroup}
          title="No teams yet"
        >
          {canCreate
            ? "Create one here. Groups from your company's directory show up as teams too."
            : "An admin creates teams. Groups from your company's directory show up as teams too."}
        </PageEmpty>
      ) : (
        <PageRows>
          {teams.map((team, index) => (
            <StaggerItem index={index} key={team.id}>
              <Item
                render={(props) => <Link {...props} {...paths.team(team.id)} />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  {team.source === "directory" ? (
                    <IconBuildingBank />
                  ) : (
                    <IconUsersGroup />
                  )}
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>{team.name}</ItemTitle>
                  {team.description ? (
                    <ItemDescription className="line-clamp-1">
                      {team.description}
                    </ItemDescription>
                  ) : null}
                  <TeamFacts team={team} teams={teams} />
                </ItemContent>
                <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Item>
              {index !== teams.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}
      {/* Only when the server says there is another page, as on Admin's People. */}
      {list.hasNextPage ? (
        <Button
          // Its own width, as under a section's rows: the page's column would stretch it.
          className="mt-4 self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {list.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </PageShell>
  );
}

/**
 * A team's second line. The team it is under is named from the teams already listed, or, when that
 * one is on a page not read yet or left out by the search, read on its own.
 */
function TeamFacts({
  team,
  teams,
}: {
  team: TeamSummary;
  teams: readonly TeamSummary[];
}) {
  const listed = teams.find((other) => other.id === team.parentTeamId);
  const parent = useQuery({
    ...teamQueryOptions(team.parentTeamId ?? ""),
    enabled: team.parentTeamId !== null && !listed,
  }).data;
  return (
    <ItemDescription>
      {teamFacts(team, (listed ?? parent)?.name)}
    </ItemDescription>
  );
}

/**
 * The personal edition shows this page's title, and that it applies to a team. `shell` is the frame
 * it is drawn in: the app's for everybody, Admin's for an admin who opened it there.
 */
export function TeamsPage({ shell = "app" }: { shell?: TeamsShell } = {}) {
  return (
    <TeamPage
      description={TEAMS_DESCRIPTION}
      more="Here, you're the only person."
      title="Teams"
    >
      <Teams paths={teamPaths(shell)} />
    </TeamPage>
  );
}
