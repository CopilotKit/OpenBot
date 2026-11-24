import {
  IconChevronRight,
  IconLink,
  IconPlus,
  IconShare,
  IconUsers,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { PeopleTypeahead } from "@/components/teams/people-typeahead";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { countLabel } from "@/lib/agents/bot-summaries";
import { publicSharingWords } from "@/lib/agents/public-words";
import type { AgentProfile } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { useOrganizationAudience } from "@/lib/organizations/queries";
import {
  assignTeamBotMutationOptions,
  publishTeamBotMutationOptions,
  type TeamBot,
  teamBotLink,
  teamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";
import {
  type TeamSummary,
  teamListQueryOptions,
  teamOfValue,
  teamValue,
} from "@/lib/teams/queries";
import { queryClient } from "@/query-client";

/** Everybody in the organization, as an assignment carries it. */
const EVERYONE = "*";
const EVERYONE_WORDS = "Everyone in the organization";

/**
 * Who else can use this Bot. Its owner publishes it to everyone in the organization or to named
 * people and teams; an admin can also pin it at the top of a team's Bots lists. Each conversation
 * with a published Bot is private to the person having it; its owner cannot read it.
 *
 * A Bot published to directory groups before there were teams keeps them: they are shown, sent
 * back unchanged, and no new one is typed. New grants go to teams.
 */
export function SharingSections({ agent }: { agent: AgentProfile }) {
  const data = useQuery(teamBotsQueryOptions());
  const teams = useQuery(teamListQueryOptions()).data?.teams;
  const me = useQuery(currentUserQueryOptions()).data;
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const audience = useOrganizationAudience();
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Who a public Bot reaches waits for whether the person is the organization's only member.
  if (data.isPending || (agent.visibility === "public" && audience.pending))
    return null;
  if (data.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {data.error.message}
      </p>
    );
  }
  const published = data.data.find((bot) => bot.botId === agent.id);
  // A Bot is its owner's to publish, and one missing from the published list isn't published yet.
  const publishable = agent.mine && published === undefined;
  const publicWords = publicSharingWords(audience);

  return (
    <>
      <PageSection title="Published">
        {unpublish.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {unpublish.error.message}
          </p>
        ) : null}
        {published ? (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsersGroup />
              </ItemMedia>
              <ItemContent className="min-w-0">
                {/*
                 * Every name is read, so the line wraps instead of being cut at one. An address
                 * has nowhere to break, so it may break anywhere before it runs under the button.
                 */}
                <ItemTitle className="line-clamp-none block w-auto [overflow-wrap:anywhere]">
                  {publishedTo(published, teams)}
                </ItemTitle>
                <ItemDescription>
                  {published.visibleToTeam
                    ? "Each person's conversations with it are private."
                    : "Other people can't see it until it has a real name and a description."}
                </ItemDescription>
              </ItemContent>
              {agent.mine ? (
                // On a phone the names keep the row's width and the button goes under them.
                <ItemActions className="max-sm:basis-full">
                  <Button
                    disabled={unpublish.isPending}
                    onClick={() => unpublish.mutate(agent.id)}
                    size="sm"
                    variant="outline"
                  >
                    Unpublish
                  </Button>
                </ItemActions>
              ) : null}
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconLink />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Link</ItemTitle>
                <ItemDescription>
                  Opens a private conversation with it.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(teamBotLink(agent.id))
                      .then(() => setCopied(true))
                  }
                  size="sm"
                  variant="outline"
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </ItemActions>
            </Item>
          </PageRows>
        ) : agent.visibility === "public" ? (
          // Public: who can use it, said once. Never "not published" beside "public".
          <PageEmpty icon={IconShare} title={publicWords.title}>
            {publicWords.description}
          </PageEmpty>
        ) : (
          <PageEmpty icon={IconShare} title="Not published">
            {agent.mine ? "Only you can use it." : null}
          </PageEmpty>
        )}
      </PageSection>
      {agent.mine && (published || publishable) ? (
        <PageSection
          description={
            // A public Bot is everyone's in the organization already: publishing it doesn't narrow that.
            agent.visibility === "public"
              ? "It's public already. Publish it to get a link to share."
              : "Only the people and teams you publish it to can use it. You can unpublish at any time."
          }
          title={published ? "Who it is published to" : "Publish"}
        >
          {/* More than one value (an audience, then people and teams), so a summary row and a
              dialog, not a form on the page. */}
          <PageRows>
            <Item
              render={
                <button onClick={() => setPublishing(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconUsersGroup />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Audience</ItemTitle>
                <ItemDescription>
                  {audienceSummary(published, agent.visibility === "public")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
          {publishing ? (
            <PublishDialog
              botId={agent.id}
              current={published}
              onClose={() => setPublishing(false)}
            />
          ) : null}
        </PageSection>
      ) : null}
      {isOrganizationAdmin(me?.role) && published ? (
        <PageSection
          description="Pins this Bot at the top of the Bots list for everyone in a team, or for everyone in the organization."
          title="Assigned to"
        >
          <Assignments bot={published} teams={teams} />
        </PageSection>
      ) : null}
    </>
  );
}

/** A team's name, by its id. One the list doesn't hold (deleted since, or not read yet) has none. */
function teamName(
  teams: readonly TeamSummary[] | undefined,
  teamId: string,
): string | undefined {
  return teams?.find((team) => team.id === teamId)?.name;
}

/**
 * Who a published Bot reaches, by name: people by their address, teams by their name, and the
 * directory groups it was published to before there were teams. Teams whose names aren't known are
 * counted, never shown by id.
 */
function publishedTo(
  published: TeamBot,
  teams: readonly TeamSummary[] | undefined,
): string {
  if (published.audience === "team")
    return `To ${EVERYONE_WORDS.toLowerCase()}`;
  const named: string[] = [];
  let unnamed = 0;
  for (const teamId of published.teams ?? []) {
    const name = teamName(teams, teamId);
    if (name) named.push(name);
    else unnamed += 1;
  }
  const reached = [
    ...(published.people ?? []),
    ...named,
    ...(unnamed > 0
      ? [countLabel(unnamed, "other team", "other teams", "")]
      : []),
    ...(published.groups ?? []).map((group) => `group ${group}`),
  ];
  return reached.length ? `To ${reached.join(", ")}` : "To nobody yet";
}

/** The current answer on the Audience row: who it is published to, as a count. */
function audienceSummary(
  current: TeamBot | undefined,
  isPublic: boolean,
): string {
  // Never "not published" beside a public Bot, which everyone in the organization can use.
  if (!current)
    return isPublic ? "Choose who to publish it to" : "Not published";
  if (current.audience === "team") return EVERYONE_WORDS;
  const parts = [
    countLabel(current.people?.length ?? 0, "person", "people", ""),
    countLabel(current.teams?.length ?? 0, "team", "teams", ""),
    countLabel(current.groups?.length ?? 0, "group", "groups", ""),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : AUDIENCES.people;
}

const AUDIENCES = {
  team: EVERYONE_WORDS,
  people: "Specific people or teams",
} as const;

/**
 * Who a Bot is published to: everyone in the organization, or named people and teams. Mounted only
 * while open, so each opening starts from the current answer and not from an abandoned edit.
 */
function PublishDialog({
  botId,
  current,
  onClose,
}: {
  botId: string;
  current?: TeamBot;
  onClose: () => void;
}) {
  const formId = useId();
  const publish = useMutation(publishTeamBotMutationOptions(queryClient));
  const teams = useQuery(teamListQueryOptions());
  const [audience, setAudience] = useState<"team" | "people">(
    current?.audience ?? "team",
  );
  // The people it is published to, by address, each chosen from the organization's members.
  const [emails, setEmails] = useState<readonly string[]>(
    () => current?.people ?? [],
  );
  const chosenEmails = new Set(emails.map((email) => email.toLowerCase()));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(current?.teams ?? []),
  );
  // Published to before there were teams. Kept as they are: shown, sent back, never typed.
  const groups = current?.groups ?? [];
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
          <DialogTitle>
            {current ? "Who it is published to" : "Publish"}
          </DialogTitle>
          <DialogDescription>
            Only the people and teams you publish it to can use it. You can
            unpublish at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              const named = audience === "people";
              publish.mutate(
                {
                  botId,
                  audience,
                  emails: named ? [...emails] : [],
                  groups: named ? groups : [],
                  teams: named ? [...chosen] : [],
                },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-audience`}>
                  Published to
                </FieldLabel>
                <Select
                  items={AUDIENCES}
                  onValueChange={(value) => {
                    if (value === "team" || value === "people") {
                      setAudience(value);
                    }
                  }}
                  value={audience}
                >
                  <SelectTrigger className="w-full" id={`${formId}-audience`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(AUDIENCES) as (keyof typeof AUDIENCES)[]).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {AUDIENCES[value]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </Field>
              {audience === "people" ? (
                <>
                  {/*
                   * A `fieldset` because that is what a group of tickboxes is, named by the heading
                   * above it. `min-w-0` undoes the min-content floor a fieldset brings, which a long
                   * team name would push the dialog out to.
                   */}
                  <fieldset
                    aria-labelledby={`${formId}-teams`}
                    className="flex min-w-0 flex-col gap-2"
                  >
                    <p
                      className="font-medium text-xs leading-none"
                      id={`${formId}-teams`}
                    >
                      Teams
                    </p>
                    {teams.isPending ? null : teams.error ? (
                      <p className="text-destructive text-sm" role="alert">
                        {teams.error.message}
                      </p>
                    ) : teams.data.teams.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        There are no teams yet. An admin creates them on the
                        Teams page.
                      </p>
                    ) : (
                      <div className="max-h-48 space-y-2 overflow-y-auto">
                        {teams.data.teams.map((team) => (
                          // A long name wraps under itself: cut short, two teams could read alike.
                          <div className="flex items-start gap-2" key={team.id}>
                            <Checkbox
                              checked={chosen.has(team.id)}
                              className="mt-0.5"
                              id={`${formId}-team-${team.id}`}
                              onCheckedChange={() => toggle(team.id)}
                            />
                            <label
                              className="min-w-0 break-words text-sm"
                              htmlFor={`${formId}-team-${team.id}`}
                            >
                              {team.name}
                            </label>
                          </div>
                        ))}
                      </div>
                    )}
                  </fieldset>
                  {/*
                    People are found among the organization's members as their name or address is
                    typed, never typed in whole: nobody outside it can be chosen.
                  */}
                  <fieldset
                    aria-labelledby={`${formId}-people`}
                    className="flex min-w-0 flex-col gap-2"
                  >
                    <p
                      className="font-medium text-xs leading-none"
                      id={`${formId}-people`}
                    >
                      People
                    </p>
                    {emails.length > 0 ? (
                      <ul
                        aria-label="People it is published to"
                        className="flex flex-wrap gap-1.5"
                      >
                        {emails.map((email) => (
                          <li
                            // Drawn as the To: field's chips are (ComboboxChip), and cut short
                            // rather than wider than the dialog.
                            className="flex h-[calc(--spacing(5.25))] min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-sm bg-muted pr-0 pl-1.5 font-medium text-foreground text-xs"
                            key={email}
                          >
                            <span className="truncate">{email}</span>
                            <Button
                              aria-label={`Remove ${email}`}
                              className="-ml-0.5 mr-0.5 size-4 rounded-sm opacity-50 hover:opacity-100"
                              onClick={() =>
                                setEmails((now) =>
                                  now.filter((one) => one !== email),
                                )
                              }
                              size="icon-xs"
                              type="button"
                              variant="ghost"
                            >
                              <IconX className="pointer-events-none" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <PeopleTypeahead
                      autoFocus={false}
                      label="People to publish it to"
                      name="People"
                      onChoose={(person) =>
                        setEmails((now) => [...now, person.email])
                      }
                      unavailable={(person) =>
                        chosenEmails.has(person.email.toLowerCase())
                          ? "Chosen"
                          : person.email.trim()
                            ? null
                            : "Hasn't signed in yet"
                      }
                    />
                  </fieldset>
                  {groups.length > 0 ? (
                    <Field>
                      <p
                        className="font-medium text-xs leading-none"
                        id={`${formId}-groups`}
                      >
                        Directory groups
                      </p>
                      <FieldDescription>
                        It stays published to {groups.join(", ")}. To reach more
                        people, choose a team.
                      </FieldDescription>
                    </Field>
                  ) : null}
                </>
              ) : null}
              <SharedAppNotice botId={botId} reason="publish" />
            </FieldGroup>
          </form>
          {publish.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {publish.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={publish.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {current ? "Update" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What an assignment is called: everyone, a team by its name, or a directory group by its own. */
function assignmentName(
  value: string,
  teams: readonly TeamSummary[] | undefined,
): string {
  if (value === EVERYONE) return EVERYONE_WORDS;
  const teamId = teamOfValue(value);
  if (teamId === null) return `Group ${value}`;
  return teamName(teams, teamId) ?? "A team that was deleted";
}

/**
 * Who an admin has pinned this Bot for: one row each with a Remove, and a row that opens a dialog
 * to add one.
 */
function Assignments({
  bot,
  teams,
}: {
  bot: TeamBot;
  teams: readonly TeamSummary[] | undefined;
}) {
  const remove = useMutation(assignTeamBotMutationOptions(queryClient));
  const [assigning, setAssigning] = useState(false);
  const assigned = bot.assignedGroups ?? [];
  return (
    <>
      {remove.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      ) : null}
      {assigned.length === 0 ? (
        <PageEmpty icon={IconUsersGroup} title="Not assigned to anyone" />
      ) : null}
      <PageRows>
        {assigned.map((value) => {
          const name = assignmentName(value, teams);
          return (
            <Fragment key={value}>
              <Item size="sm">
                <ItemMedia variant="icon">
                  {value === EVERYONE ? <IconUsers /> : <IconUsersGroup />}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={`Remove ${name}`}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate({
                        botId: bot.botId,
                        group: value,
                        remove: true,
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </ItemActions>
              </Item>
              <Separator />
            </Fragment>
          );
        })}
        <Item
          render={<button onClick={() => setAssigning(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconPlus />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Assign to a team or everyone</ItemTitle>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {assigning ? (
        <AssignDialog
          bot={bot}
          onClose={() => setAssigning(false)}
          teams={teams ?? []}
        />
      ) : null}
    </>
  );
}

/** One team to pin this Bot for, or everyone in the organization. What it already has is left out. */
function AssignDialog({
  bot,
  teams,
  onClose,
}: {
  bot: TeamBot;
  teams: readonly TeamSummary[];
  onClose: () => void;
}) {
  const formId = useId();
  const assign = useMutation(assignTeamBotMutationOptions(queryClient));
  const taken = new Set(bot.assignedGroups ?? []);
  const choices: Record<string, string> = Object.fromEntries(
    [
      [EVERYONE, EVERYONE_WORDS] as const,
      ...teams.map((team) => [teamValue(team.id), team.name] as const),
    ].filter(([value]) => !taken.has(value)),
  );
  const [group, setGroup] = useState<string | null>(null);
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign {bot.name}</DialogTitle>
          <DialogDescription>
            It's pinned at the top of their Bots list, and they can't hide it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (group === null) return;
              assign.mutate(
                { botId: bot.botId, group },
                { onSuccess: onClose },
              );
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-group`}>Assign to</FieldLabel>
              <Select
                items={choices}
                onValueChange={(value) => setGroup(String(value))}
                value={group}
              >
                <SelectTrigger className="w-full" id={`${formId}-group`}>
                  <SelectValue placeholder="Choose a team or everyone" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(choices).map(([value, name]) => (
                    <SelectItem key={value} value={value}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </form>
          {assign.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {assign.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={group === null || assign.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
