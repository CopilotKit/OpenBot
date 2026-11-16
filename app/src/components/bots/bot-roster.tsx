import {
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ComponentProps,
  Fragment,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { RosterTagEditor } from "@/components/bots/roster-tags";
import { readBotTags, rosterTagKey } from "@/lib/agents/roster-tags";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  waitingOnYou,
} from "@/components/bot-profile/attention";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { NeedsYouBoard } from "@/components/needs-you/board";
import { DoneTasks, useNeedsYou } from "@/components/needs-you/needs-you";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import {
  filterRoster,
  groupRoster,
  type RosterFilters,
} from "@/lib/agents/roster";
import { shownSubtitle } from "@/lib/agents/subtitle";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/** Keep the native picker and keyboard behavior, with a caret inset consistently in either direction. */
function RosterSelect(props: Omit<ComponentProps<"select">, "className">) {
  return (
    <span className="relative block">
      <select
        {...props}
        className="h-9 w-full max-w-full appearance-none rounded-lg border border-input bg-card ps-2.5 pe-9 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring md:text-sm"
      />
      <IconChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

/**
 * Every Bot the person can reach, in the one place they are listed: what needs the person first,
 * then pinned, then their own, then the ones shared with them, and the ones they hid folded away at
 * the end.
 *
 * Needs you is where the sidebar's badge leads, so it holds everything behind that number in one
 * card: the Bots with a question, an approval or a stalled hand-off (answered on the Bot's page),
 * the tasks started from check-ins, and what every Bot's check-ins found, each row naming its Bot.
 *
 * This replaces three screens (Bots, Agents and Team Bots) that listed the same Bots three ways.
 */
export function BotRoster() {
  const [filters, setFilters] = useState<RosterFilters>({
    query: "",
    scope: "all",
    sort: "default",
  });
  const controlId = useId();
  const userId = useQuery(currentUserQueryOptions()).data?.id;
  const [tagSelection, setTagSelection] = useState<{
    userId: string | undefined;
    value: string;
  }>({ userId: undefined, value: "all" });
  const tagFilter = tagSelection.userId === userId ? tagSelection.value : "all";
  const setTagFilter = (value: string) => setTagSelection({ userId, value });
  const filtering =
    filters.query.trim() !== "" ||
    filters.scope !== "all" ||
    tagFilter !== "all";
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const attention = useQuery(botAttentionQueryOptions());
  const list = useNeedsYou();
  const [tagRevision, setTagRevision] = useState(0);
  const tags = useMemo(() => {
    // The revision invalidates local reads after a save or another tab's storage event.
    void tagRevision;
    return new Map(
      [...(agents.data ?? []), ...(hidden.data ?? [])].map((agent) => [
        agent.id,
        readBotTags(userId, agent.id),
      ]),
    );
  }, [agents.data, hidden.data, userId, tagRevision]);
  useEffect(() => {
    if (!userId) return;
    const prefix = rosterTagKey(userId, "");
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(prefix))
        setTagRevision((revision) => revision + 1);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [userId]);
  const tagChoices = new Map<string, string>();
  for (const names of tags.values()) {
    for (const name of names) {
      const key = `tag:${name.toLocaleLowerCase()}`;
      if (!tagChoices.has(key)) tagChoices.set(key, name);
    }
  }
  const tagProps = {
    userId,
    tags,
    onTagsChanged: () => setTagRevision((revision) => revision + 1),
  };
  const matchesTag = (agent: AgentProfile) => {
    const names = tags.get(agent.id) ?? [];
    return (
      tagFilter === "all" ||
      (tagFilter === "untagged"
        ? names.length === 0
        : names.some((name) => `tag:${name.toLocaleLowerCase()}` === tagFilter))
    );
  };
  const byId = new Map((attention.data ?? []).map((bot) => [bot.botId, bot]));

  if (agents.isPending)
    return (
      <PageSection>
        <LoadingRows label="Loading your Bots" media="avatar" />
      </PageSection>
    );
  // Only when nothing ever loaded: a failed background refetch keeps the roster it had.
  if (agents.data === undefined) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        Couldn't load your Bots. Reload the page.
      </p>
    );
  }
  // Every Bot stays in its own section; what it waits on is on the board above, by name.
  const visible = filterRoster(agents.data.filter(matchesTag), filters, tags);
  const hiddenMatches = filterRoster(
    (hidden.data ?? []).filter(matchesTag),
    filters,
    tags,
  );
  const { pinned, yours, shared } = groupRoster(visible);
  const available = agents.data.length;
  const hiddenCount = hidden.data?.length ?? 0;
  const newBot = (
    <Button
      render={(props) => <Link {...props} search={{ new: true }} to="/bots" />}
      size="sm"
      variant="outline"
    >
      <IconPlus />
      New Bot
    </Button>
  );

  return (
    <>
      {/*
       * What waits on the person, each thing under the Bot it came from and decided where it is.
       * A Bot waiting on them stays in its own section below too, with its badge.
       */}
      <NeedsYouBoard />
      <search aria-label="Find Bots" className="mt-6 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label
            className="flex min-w-48 flex-1 flex-col gap-1 text-sm"
            htmlFor={`${controlId}-query`}
          >
            Search Bots
            <Input
              id={`${controlId}-query`}
              type="search"
              name="query"
              autoComplete="off"
              placeholder="Name, title, description or tag"
              value={filters.query}
              onChange={(event) =>
                setFilters({ ...filters, query: event.target.value })
              }
            />
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${controlId}-scope`}
          >
            Show Bots
            <RosterSelect
              id={`${controlId}-scope`}
              name="scope"
              value={filters.scope}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  scope: event.target.value as RosterFilters["scope"],
                })
              }
            >
              <option value="all">All Bots</option>
              <option value="yours">Yours</option>
              <option value="shared">
                {personal ? "Included with OpenBot" : "Shared with you"}
              </option>
              <option value="pinned">Pinned</option>
            </RosterSelect>
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${controlId}-sort`}
          >
            Sort Bots
            <RosterSelect
              id={`${controlId}-sort`}
              name="sort"
              value={filters.sort}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  sort: event.target.value as RosterFilters["sort"],
                })
              }
            >
              <option value="default">Default order</option>
              <option value="name-asc">Name: A–Z</option>
              <option value="name-desc">Name: Z–A</option>
              <option value="title-asc">Title: A–Z</option>
              <option value="title-desc">Title: Z–A</option>
              <option value="description-asc">Description: A–Z</option>
              <option value="description-desc">Description: Z–A</option>
            </RosterSelect>
          </label>
          {userId ? (
            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor={`${controlId}-tag`}
            >
              Filter by tag
              <RosterSelect
                id={`${controlId}-tag`}
                name="tag"
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
              >
                <option value="all">All tags</option>
                <option value="untagged">Untagged</option>
                {[...tagChoices]
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([key, name]) => (
                    <option key={key} value={key}>
                      Tag: {name}
                    </option>
                  ))}
                {tagFilter.startsWith("tag:") && !tagChoices.has(tagFilter) ? (
                  <option value={tagFilter}>Tag: {tagFilter.slice(4)}</option>
                ) : null}
              </RosterSelect>
            </label>
          ) : null}
          {filtering || filters.sort !== "default" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters({ query: "", scope: "all", sort: "default" });
                setTagFilter("all");
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm" role="status">
          {visible.length} of {available} Bots
          {hiddenMatches.length ? ` · ${hiddenMatches.length} hidden` : ""}
        </p>
      </search>
      {filtering &&
      visible.length === 0 &&
      hiddenMatches.length === 0 &&
      !hidden.isPending ? (
        <PageSection>
          <PageEmpty icon={IconBolt} title="No matching Bots">
            Try another search or clear the filters.
          </PageEmpty>
        </PageSection>
      ) : null}
      {/*
       * AVAILABLE BOTS FIRST, AND ONLY SECTIONS WITH BOTS IN THEM. An empty Yours used to sit above
       * the assistant OpenBot includes, so the first thing a new person read was "No Bots yet" over
       * a Bot they could talk to. The way to make one is a sentence after them instead, beside the
       * page's own New Bot.
       */}
      {pinned.length ? (
        <PageSection title="Pinned">
          <RosterRows agents={pinned} byId={byId} {...tagProps} />
        </PageSection>
      ) : null}
      {yours.length ? (
        <PageSection title="Yours">
          <RosterRows agents={yours} byId={byId} {...tagProps} />
        </PageSection>
      ) : null}
      {shared.length ? (
        <PageSection
          title={personal ? "Included with OpenBot" : "Shared with you"}
        >
          <RosterRows agents={shared} byId={byId} {...tagProps} />
        </PageSection>
      ) : null}
      {!filtering && available === 0 ? (
        // Waits for the hidden list, so it never says "No Bots yet" to someone who hid theirs.
        hidden.isPending ? null : (
          <PageSection>
            <PageEmpty
              action={newBot}
              icon={IconBolt}
              title={hiddenCount ? "No Bots on your list" : "No Bots yet"}
            >
              {hiddenCount
                ? "The Bots you hid are below. Create a Bot for a specific job."
                : "Create a Bot for a specific job."}
            </PageEmpty>
          </PageSection>
        )
      ) : !filtering && yours.length === 0 ? (
        <p className="mt-12 text-muted-foreground text-sm">
          Create a Bot for a specific job.{" "}
          <Link
            className="font-medium text-foreground underline underline-offset-4"
            search={{ new: true }}
            to="/bots"
          >
            New Bot
          </Link>
        </p>
      ) : null}
      <DoneTasks done={list.done} />
      {hiddenMatches.length ? (
        <HiddenSection
          agents={hiddenMatches}
          byId={byId}
          personal={personal}
          {...tagProps}
        />
      ) : null}
    </>
  );
}

/**
 * The Bots this person hid, folded until asked for: a way back for somebody who hid something, not
 * a fourth list everybody reads past. A Bot's page is where Unhide lives. The personal edition has
 * nobody else with a list, so it doesn't say only theirs changed.
 */
function HiddenSection({
  agents,
  byId,
  personal,
  ...tagProps
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
  personal: boolean;
} & TagProps) {
  const [open, setOpen] = useState(false);
  return (
    <PageSection
      action={
        <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
          {open ? "Hide" : "Show"}
        </Button>
      }
      description={`${agents.length} ${agents.length === 1 ? "Bot" : "Bots"} you hid.${personal ? "" : " Only your list changes."}`}
      title="Hidden"
    >
      {open ? <RosterRows agents={agents} byId={byId} {...tagProps} /> : null}
    </PageSection>
  );
}

type TagProps = {
  userId: string | undefined;
  tags: ReadonlyMap<string, readonly string[]>;
  onTagsChanged: () => void;
};

function RosterRows({
  agents,
  byId,
  userId,
  tags,
  onTagsChanged,
}: {
  agents: AgentProfile[];
  byId: Map<string, BotAttention>;
} & TagProps) {
  return (
    <PageRows>
      {agents.map((agent, index) => (
        <Fragment key={agent.id}>
          {index > 0 ? <Separator /> : null}
          <div className="flex items-center gap-1">
            <RosterRow
              agent={agent}
              state={byId.get(agent.id)}
              tags={tags.get(agent.id) ?? []}
            />
            {userId ? (
              <RosterTagEditor
                key={`${userId}:${agent.id}`}
                userId={userId}
                botId={agent.id}
                name={agent.name}
                tags={tags.get(agent.id) ?? []}
                onSaved={onTagsChanged}
              />
            ) : null}
          </div>
        </Fragment>
      ))}
    </PageRows>
  );
}

/**
 * One Bot, opening its page. The count is everything from it that waits on the person, its
 * check-in items and tasks included, so a Bot whose items are listed under Needs you still says so
 * wherever it sits.
 */
function RosterRow({
  agent,
  state,
  tags,
}: {
  agent: AgentProfile;
  state: BotAttention | undefined;
  tags: readonly string[];
}) {
  const summary = state
    ? [state.paused ? "Paused" : "", attentionSummary(state)]
        .filter(Boolean)
        .join(" · ")
    : "";
  const waiting = state ? waitingOnYou(state) : 0;
  return (
    <Item
      className="min-w-0 flex-1"
      render={<Link params={{ agentId: agent.id }} to="/bots/$agentId" />}
      size="sm"
    >
      <ItemMedia>
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={28} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{agent.name}</ItemTitle>
        <ItemDescription>
          {summary || shownSubtitle(agent.title)}
        </ItemDescription>
        {tags.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="max-w-full break-words rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </ItemContent>
      <ItemActions>
        {waiting > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
            {waiting}
          </span>
        ) : null}
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
