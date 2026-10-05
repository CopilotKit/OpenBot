import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { PageShell, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  assignTeamBotMutationOptions,
  clearTeamBotConsentsMutationOptions,
  publishTeamBotMutationOptions,
  type TeamBot,
  teamBotLink,
  teamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";

/**
 * Team Bots: find the Bots teammates published, publish your own to the team or to named people and
 * groups, and (administrators) put one in a group's sidebars. A chat with a Team Bot is always the
 * teammate's own; its owner cannot read it.
 */
export const Route = createFileRoute("/_authed/_app/team-bots")({
  component: TeamBotsPage,
});

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

function TeamBotsPage() {
  const data = useQuery(teamBotsQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  const bots = data.data?.teamBots ?? [];
  const shared = bots.filter((bot) => !bot.mine);
  const mine = bots.filter((bot) => bot.mine);

  return (
    <PageShell
      description="Bots your teammates published, and the ones you share. Each chat with a Team Bot is private to the person having it."
      title="Team Bots"
      width="wide"
    >
      {data.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {data.error.message}
        </p>
      ) : null}
      <PageSection title="Available to you">
        {shared.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody has published a Bot to you yet.
          </p>
        ) : (
          shared.map((bot) => <TeamBotRow bot={bot} key={bot.id} />)
        )}
      </PageSection>
      <PageSection title="Yours">
        {mine.map((bot) => (
          <div className="flex flex-col gap-2" key={bot.id}>
            <TeamBotRow bot={bot} />
            <PublishForm botId={bot.id} current={bot} />
          </div>
        ))}
        {(data.data?.publishable ?? []).length ? (
          <PublishNew publishable={data.data?.publishable ?? []} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You have no Bots of your own to publish.
          </p>
        ) : null}
      </PageSection>
      {me?.role === "admin" ? (
        <PageSection title="Assign to groups">
          <p className="text-sm text-muted-foreground">
            An assigned Bot appears in every member's sidebar, and they cannot
            hide it. Use * for the whole team.
          </p>
          {bots.map((bot) => (
            <Assignments bot={bot} key={bot.id} />
          ))}
        </PageSection>
      ) : null}
      <PageSection title="Your accounts">
        <p className="text-sm text-muted-foreground">
          A Team Bot uses its owner's connected apps. It uses your own account
          only when you allow it on the card it shows you.
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
            size="sm"
            variant="outline"
          >
            Clear connector preferences
          </Button>
          {clear.isSuccess ? (
            <span className="text-sm text-muted-foreground" role="status">
              Cleared. Team Bots will ask again.
            </span>
          ) : null}
        </div>
      </PageSection>
    </PageShell>
  );
}

function TeamBotRow({ bot }: { bot: TeamBot }) {
  const queryClient = useQueryClient();
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
      data-team-bot={bot.id}
    >
      <ChannelAvatar participantIds={[bot.id]} size={28} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{bot.name}</span>
        <span className="truncate text-sm text-muted-foreground">
          {bot.title}
          {bot.assigned ? " · assigned to you" : ""}
          {bot.mine && !bot.visibleToTeam
            ? " · hidden from teammates until it has a real name and a description"
            : ""}
          {bot.mine
            ? bot.audience === "team"
              ? " · published to the whole team"
              : ` · published to ${[...(bot.people ?? []), ...(bot.groups ?? []).map((group) => `group ${group}`)].join(", ")}`
            : ""}
        </span>
      </div>
      <Button
        render={(props) => (
          <Link {...props} search={{ agent: bot.id }} to="/channel/new" />
        )}
        size="sm"
      >
        Start a private chat
      </Button>
      <Button
        onClick={() =>
          void navigator.clipboard
            .writeText(teamBotLink(bot.id))
            .then(() => setCopied(true))
        }
        size="sm"
        variant="outline"
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
      {bot.mine ? (
        <Button
          disabled={unpublish.isPending}
          onClick={() => unpublish.mutate(bot.id)}
          size="sm"
          variant="ghost"
        >
          Unpublish
        </Button>
      ) : null}
    </div>
  );
}

function PublishNew({
  publishable,
}: {
  publishable: { id: string; name: string }[];
}) {
  const [botId, setBotId] = useState(publishable[0]?.id ?? "");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <label className="grid gap-1 text-sm">
        Publish one of your Bots
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          onChange={(event) => setBotId(event.target.value)}
          value={botId}
        >
          {publishable.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {botId ? <PublishForm botId={botId} key={botId} /> : null}
    </div>
  );
}

/** Who a Bot is published to: the whole team, or named people and groups. */
function PublishForm({ botId, current }: { botId: string; current?: TeamBot }) {
  const queryClient = useQueryClient();
  const publish = useMutation(publishTeamBotMutationOptions(queryClient));
  const [audience, setAudience] = useState<"team" | "people">(
    current?.audience ?? "team",
  );
  const [emails, setEmails] = useState((current?.people ?? []).join(", "));
  const [groups, setGroups] = useState((current?.groups ?? []).join(", "));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        publish.mutate({
          botId,
          audience,
          emails: audience === "people" ? list(emails) : [],
          groups: audience === "people" ? list(groups) : [],
        });
      }}
    >
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            checked={audience === "team"}
            name={`audience-${botId}`}
            onChange={() => setAudience("team")}
            type="radio"
          />
          The whole team
        </label>
        <label className="flex items-center gap-1.5">
          <input
            checked={audience === "people"}
            name={`audience-${botId}`}
            onChange={() => setAudience("people")}
            type="radio"
          />
          Specific people or groups
        </label>
      </div>
      {audience === "people" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            aria-label="People, by email"
            onChange={(event) => setEmails(event.target.value)}
            placeholder="People, by email, comma separated"
            value={emails}
          />
          <Input
            aria-label="Groups"
            onChange={(event) => setGroups(event.target.value)}
            placeholder="Groups, comma separated"
            value={groups}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button disabled={publish.isPending} size="sm" type="submit">
          {current ? "Update" : "Publish to team"}
        </Button>
        {publish.error ? (
          <span className="text-sm text-destructive" role="alert">
            {publish.error.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function Assignments({ bot }: { bot: TeamBot }) {
  const queryClient = useQueryClient();
  const assign = useMutation(assignTeamBotMutationOptions(queryClient));
  const [group, setGroup] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{bot.name}</span>
      {(bot.assignments ?? []).map((name) => (
        <Button
          aria-label={`Remove ${name}`}
          key={name}
          onClick={() =>
            assign.mutate({ botId: bot.id, group: name, remove: true })
          }
          size="sm"
          variant="outline"
        >
          {name === "*" ? "Whole team" : name} ×
        </Button>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          assign.mutate(
            { botId: bot.id, group },
            { onSuccess: () => setGroup("") },
          );
        }}
      >
        <Input
          aria-label={`Assign ${bot.name} to a group`}
          className="w-40"
          onChange={(event) => setGroup(event.target.value)}
          placeholder="Group, or *"
          value={group}
        />
        <Button
          disabled={!group.trim() || assign.isPending}
          size="sm"
          type="submit"
        >
          Assign
        </Button>
      </form>
      {assign.error ? (
        <span className="text-destructive" role="alert">
          {assign.error.message}
        </span>
      ) : null}
    </div>
  );
}
