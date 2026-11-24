import { IconChevronRight, IconUsersGroup } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  replaceAppTeamGrantsMutationOptions,
  replaceSkillTeamGrantsMutationOptions,
} from "@/lib/team-grants/mutations";
import {
  appTeamGrantsQueryOptions,
  skillTeamGrantsQueryOptions,
  type TeamGrants,
} from "@/lib/team-grants/queries";
import { MISSING_TEAM, teamName } from "@/lib/teams/names";
import { type TeamSummary, teamListQueryOptions } from "@/lib/teams/queries";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

/**
 * The Teams row of an app's page and of a skill's page in Admin, and the dialog it opens.
 *
 * Granting an app or a skill to a team lets the people in that team put it on Bots they own without
 * asking an admin. More than one value, so the row is a summary and a chevron and the teams are
 * ticked in a dialog, the way a Bot's Publish dialog ticks them.
 */

/** How the row sits in the card it is drawn in. */
type Placement = {
  /**
   * Where the divider between this row and its neighbour goes. The row draws it, so nothing is
   * left dangling while the row has no answer yet and draws nothing.
   */
  separator: "before" | "after";
  /** The leading icon. Left out in a card whose other rows have none. */
  icon?: boolean;
};

/** The Teams row on an app's page. `appId` is the app's id, as the list of apps answers it. */
export function AppTeamGrantsRow({
  appId,
  title,
  ...placement
}: { appId: string; title: string } & Placement) {
  const granted = useQuery(appTeamGrantsQueryOptions(appId));
  const replace = useMutation(replaceAppTeamGrantsMutationOptions(queryClient));
  return (
    <TeamGrantsRow
      {...placement}
      granted={granted}
      onOpen={replace.reset}
      onSave={(teams, done) =>
        replace.mutate({ appId, teams }, { onSuccess: done })
      }
      saveError={replace.error}
      saving={replace.isPending}
      title={title}
    />
  );
}

/** The Teams row on a skill's page. `skillId` is the skill's slug. */
export function SkillTeamGrantsRow({
  skillId,
  title,
  ...placement
}: { skillId: string; title: string } & Placement) {
  const granted = useQuery(skillTeamGrantsQueryOptions(skillId));
  const replace = useMutation(
    replaceSkillTeamGrantsMutationOptions(queryClient),
  );
  return (
    <TeamGrantsRow
      {...placement}
      granted={granted}
      onOpen={replace.reset}
      onSave={(teams, done) =>
        replace.mutate({ skillId, teams }, { onSuccess: done })
      }
      saveError={replace.error}
      saving={replace.isPending}
      title={title}
    />
  );
}

type RowProps = Placement & {
  /** The app or the skill, by the name its page is titled with. */
  title: string;
  granted: {
    isPending: boolean;
    error: Error | null;
    data: TeamGrants | undefined;
  };
  saving: boolean;
  saveError: Error | null;
  /** Called as the dialog opens, so it never opens on the last attempt's error. */
  onOpen: () => void;
  /** Replace the grants with these teams, and call `done` once the server holds them. */
  onSave: (teams: TeamGrants, done: () => void) => void;
};

function TeamGrantsRow({
  title,
  granted,
  saving,
  saveError,
  onOpen,
  onSave,
  separator,
  icon = true,
}: RowProps) {
  const teams = useQuery(teamListQueryOptions());
  const [open, setOpen] = useState(false);

  // Nothing while either read is open: a row with half its answer would name no team or the wrong ones.
  if (granted.isPending || teams.isPending) return null;

  const failed = granted.error ?? teams.error;
  const media = icon ? (
    <ItemMedia variant="icon">
      <IconUsersGroup />
    </ItemMedia>
  ) : null;
  const row =
    failed || !granted.data || !teams.data ? (
      <Item size="sm">
        {media}
        <ItemContent>
          <ItemTitle>Teams</ItemTitle>
          <ItemDescription role="alert">
            {failed?.message ??
              "Couldn't load the teams it's given to. Try again in a moment."}
          </ItemDescription>
        </ItemContent>
      </Item>
    ) : (
      <>
        <Item
          render={
            <button
              onClick={() => {
                onOpen();
                setOpen(true);
              }}
              type="button"
            />
          }
          size="sm"
        >
          {media}
          <ItemContent>
            <ItemTitle>Teams</ItemTitle>
            {/* Every name is read, so the line wraps instead of being cut at two. */}
            <ItemDescription className="line-clamp-none">
              {grantedSummary(granted.data, teams.data.teams)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </ItemActions>
        </Item>
        {open ? (
          <TeamGrantsDialog
            error={saveError}
            granted={granted.data}
            onClose={() => setOpen(false)}
            onSave={onSave}
            saving={saving}
            teams={teams.data.teams}
            title={title}
          />
        ) : null}
      </>
    );

  return (
    <>
      {separator === "before" ? <Separator /> : null}
      {row}
      {separator === "after" ? <Separator /> : null}
    </>
  );
}

/** The current answer on the row: the teams by name, in the order the server keeps them. */
function grantedSummary(
  granted: TeamGrants,
  teams: readonly TeamSummary[],
): string {
  if (granted.length === 0) return "It isn't given to any team.";
  return granted.map((teamId) => teamName(teams, teamId)).join(", ");
}

/**
 * The organization's teams to tick. Mounted only while open, so each opening starts from what the
 * server holds and not from an abandoned edit.
 */
function TeamGrantsDialog({
  title,
  granted,
  teams,
  saving,
  error,
  onSave,
  onClose,
}: {
  title: string;
  granted: TeamGrants;
  teams: readonly TeamSummary[];
  saving: boolean;
  error: Error | null;
  onSave: (teams: TeamGrants, done: () => void) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(granted),
  );
  /*
   * Every team of the organization, then each granted team that is no longer one of them. Those are
   * listed ticked under what a deleted team is called everywhere, so they can be unticked and taken
   * off on save.
   */
  const choices = [
    ...teams.map((team) => ({ id: team.id, name: team.name })),
    ...granted
      .filter((teamId) => !teams.some((team) => team.id === teamId))
      .map((teamId) => ({ id: teamId, name: MISSING_TEAM })),
  ];
  const toggle = (teamId: string) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (!next.delete(teamId)) next.add(teamId);
      return next;
    });
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Teams that can use {title}</DialogTitle>
          <DialogDescription>
            People in the teams you tick can put {title} on their Bots without
            asking an admin, starting with its actions that only read. Nobody
            else's Bot in the organization can use it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {choices.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              There are no teams yet. Create one on the Teams page.
            </p>
          ) : (
            // Filled rows: a card-coloured row is invisible against a dialog.
            <div className="flex flex-col gap-px">
              {choices.map((choice) => (
                <Item key={choice.id} size="sm" variant="muted">
                  <ItemContent className="min-w-0">
                    {/* A long name wraps under itself: cut short, two teams could read alike. */}
                    <ItemTitle className="line-clamp-none block w-auto [overflow-wrap:anywhere]">
                      {choice.name}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <Checkbox
                      aria-label={choice.name}
                      checked={chosen.has(choice.id)}
                      onCheckedChange={() => toggle(choice.id)}
                    />
                  </ItemActions>
                </Item>
              ))}
            </div>
          )}
          {error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {failureSaid(error)}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={saving || choices.length === 0}
            onClick={() => onSave([...chosen], onClose)}
            size="sm"
            type="button"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
