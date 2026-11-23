import {
  IconBuildingBank,
  IconChevronRight,
  IconPlus,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TeamPage } from "@/components/edition/for-a-team";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { teamListQueryOptions } from "@/lib/teams/queries";
import { type TeamPaths, type TeamsShell, teamPaths } from "./team-paths";
import { TEAMS_DESCRIPTION, teamFacts } from "./team-words";

/**
 * The organization's teams: each one's name, what it is for, how many people are in it, whether it
 * comes from the company's directory, and the reader's own role in it. A team opens to its page;
 * New team is its own screen, offered only to whoever the server lets create one.
 */
function Teams({ paths }: { paths: TeamPaths }) {
  const list = useQuery(teamListQueryOptions());
  const teams = list.data?.teams ?? [];
  const canCreate = list.data?.canCreate === true;

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
      {list.isPending ? null : list.error ? (
        <p className="text-destructive text-sm" role="alert">
          {list.error.message}
        </p>
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
                  <ItemDescription>{teamFacts(team, teams)}</ItemDescription>
                </ItemContent>
                <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Item>
              {index !== teams.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}
    </PageShell>
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
