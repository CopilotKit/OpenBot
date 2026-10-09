import {
  IconChevronRight,
  IconLink,
  IconPlus,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { queryClient } from "@/query-client";

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
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
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
          {/* More than one value — an audience, then people and groups — so a summary row and a
              dialog rather than a form on the page. */}
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
                <ItemDescription>{audienceSummary(published)}</ItemDescription>
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
      {me?.role === "admin" && published ? (
        <PageSection
          description="An assigned Bot is pinned at the top of every member's Bots list. Use * for the whole team."
          title="Assign to groups"
        >
          <Assignments bot={published} />
        </PageSection>
      ) : null}
    </>
  );
}

/** The current answer on the Audience row: who it is published to, as a count. */
function audienceSummary(current: TeamBot | undefined): string {
  if (!current) return "Not published";
  if (current.audience === "team") return "The whole team";
  const parts = [
    countLabel(current.people?.length ?? 0, "person", "people", ""),
    countLabel(current.groups?.length ?? 0, "group", "groups", ""),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Specific people or groups";
}

const AUDIENCES = {
  team: "The whole team",
  people: "Specific people or groups",
} as const;

/**
 * Who a Bot is published to: the whole team, or named people and groups. Mounted only while open,
 * so each opening starts from the current answer rather than from an abandoned edit.
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
  const [audience, setAudience] = useState<"team" | "people">(
    current?.audience ?? "team",
  );
  const [emails, setEmails] = useState((current?.people ?? []).join(", "));
  const [groups, setGroups] = useState((current?.groups ?? []).join(", "));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {current ? "Who it is published to" : "Publish"}
          </DialogTitle>
          <DialogDescription>
            Publishing does not change its visibility, and it can be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              publish.mutate(
                {
                  botId,
                  audience,
                  emails: audience === "people" ? list(emails) : [],
                  groups: audience === "people" ? list(groups) : [],
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
                  <Field>
                    <FieldLabel htmlFor={`${formId}-people`}>
                      People, by email
                    </FieldLabel>
                    <Input
                      id={`${formId}-people`}
                      onChange={(event) => setEmails(event.target.value)}
                      placeholder="Comma separated"
                      value={emails}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${formId}-groups`}>Groups</FieldLabel>
                    <Input
                      id={`${formId}-groups`}
                      onChange={(event) => setGroups(event.target.value)}
                      placeholder="Comma separated"
                      value={groups}
                    />
                  </Field>
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
            {current ? "Update" : "Publish to team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The groups an administrator has pinned this Bot for: one row each with a Remove, and a row that
 * opens a dialog to add one.
 */
function Assignments({ bot }: { bot: TeamBot }) {
  const remove = useMutation(assignTeamBotMutationOptions(queryClient));
  const [assigning, setAssigning] = useState(false);
  const assigned = bot.assignments ?? [];
  return (
    <>
      {remove.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      ) : null}
      {assigned.length === 0 ? (
        <PageEmpty>Not assigned to any group.</PageEmpty>
      ) : null}
      <PageRows>
        {assigned.map((name) => (
          <Fragment key={name}>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsers />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name === "*" ? "Whole team" : name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={`Remove ${name}`}
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({ botId: bot.id, group: name, remove: true })
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
        ))}
        <Item
          render={<button onClick={() => setAssigning(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconPlus />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Assign to a group</ItemTitle>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {assigning ? (
        <AssignDialog bot={bot} onClose={() => setAssigning(false)} />
      ) : null}
    </>
  );
}

/** One group to pin this Bot for, or * for the whole team. */
function AssignDialog({ bot, onClose }: { bot: TeamBot; onClose: () => void }) {
  const formId = useId();
  const assign = useMutation(assignTeamBotMutationOptions(queryClient));
  const [group, setGroup] = useState("");
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign {bot.name} to a group</DialogTitle>
          <DialogDescription>
            It is pinned at the top of every member's Bots list.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              assign.mutate({ botId: bot.id, group }, { onSuccess: onClose });
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-group`}>Group, or *</FieldLabel>
              <Input
                id={`${formId}-group`}
                onChange={(event) => setGroup(event.target.value)}
                placeholder="* for the whole team"
                value={group}
              />
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
            disabled={!group.trim() || assign.isPending}
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
