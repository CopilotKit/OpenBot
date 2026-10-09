import { IconLink, IconUsersGroup } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { AgentProfile } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  assignTeamBotMutationOptions,
  publishTeamBotMutationOptions,
  type TeamBot,
  teamBotLink,
  teamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Who else can use this Bot. Its owner publishes it to the whole team or to named people and groups;
 * an administrator can also pin it at the top of a group's Bots lists. Each chat with a published
 * Bot is private to the person having it; its owner cannot read it.
 */
export function SharingSections({ agent }: { agent: AgentProfile }) {
  const data = useQuery(teamBotsQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const queryClient = useQueryClient();
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  if (data.isPending) return null;
  if (data.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {data.error.message}
      </p>
    );
  }
  const published = data.data.teamBots.find((bot) => bot.id === agent.id);
  const publishable = data.data.publishable.some((bot) => bot.id === agent.id);

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
              <ItemContent>
                <ItemTitle>
                  {published.audience === "team"
                    ? "To the whole team"
                    : `To ${[...(published.people ?? []), ...(published.groups ?? []).map((group) => `group ${group}`)].join(", ")}`}
                </ItemTitle>
                <ItemDescription>
                  {published.visibleToTeam
                    ? "Each chat with it is private to the person having it."
                    : "Hidden from teammates until it has a real name and a description."}
                </ItemDescription>
              </ItemContent>
              {agent.mine ? (
                <ItemActions>
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
                <ItemDescription>Opens a private chat with it.</ItemDescription>
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
        ) : (
          <PageEmpty>
            {agent.visibility === "public"
              ? "Not published to the team. It is public, so everyone in the deployment can already use it."
              : agent.mine
                ? "Not published. Only you can use it."
                : "Not published."}
          </PageEmpty>
        )}
      </PageSection>
      {agent.mine && (published || publishable) ? (
        <PageSection
          description="Publishing does not change its visibility, and it can be undone."
          title={published ? "Who it is published to" : "Publish"}
        >
          <div className="mt-4">
            <PublishForm botId={agent.id} current={published} />
          </div>
        </PageSection>
      ) : null}
      {me?.role === "admin" && published ? (
        <PageSection
          description="An assigned Bot is pinned at the top of every member's Bots list. Use * for the whole team."
          title="Assign to groups"
        >
          <div className="mt-4">
            <Assignments bot={published} />
          </div>
        </PageSection>
      ) : null}
    </>
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
      <SharedAppNotice botId={botId} reason="publish" />
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
