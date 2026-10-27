import {
  IconBox,
  IconBrain,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCalendarRepeat,
  IconChevronRight,
  IconPlug,
  IconSettings,
  IconTargetArrow,
  IconUserCircle,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { providerIcon } from "@/components/settings/linked-accounts";
import { Item } from "@/components/ui/item";
import { type ConnectionRow, connectionRows } from "@/lib/connections/rows";
import {
  identityProvidersQueryOptions,
  linkedAccountsQueryOptions,
} from "@/lib/identity/queries";
import {
  createMemoryMutationOptions,
  deleteMemoryMutationOptions,
  type MemoryRecord,
  memoriesQueryOptions,
  updateMemoryMutationOptions,
} from "@/lib/memory";
import {
  connectionsQueryOptions,
  personalConnections,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  brokeredAccountsListedOn,
  serversListedFor,
  sharedAccountsListedOn,
} from "@/routes/_authed/_app/connections.index";
import { useMuse } from "../context";
import { mascotTint } from "../model";
import {
  ErrorNotice,
  HeadingLink,
  LinkRow,
  Mascot,
  MuseButton,
  MuseCard,
  MuseField,
  MuseScreen,
  museText,
  SectionHeading,
} from "../ui";

/** How many memories the card shows before "See all" takes over. */
const MEMORIES_SHOWN = 6;

/**
 * Apps: the accounts the person's Bots use as them, what those Bots can do and remember, and the
 * centre Bot's own setup. Every row opens the OpenBot page where that thing is edited.
 */
export function AppsScreen() {
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  return (
    <MuseScreen title="Apps">
      <div className="flex flex-col gap-[22px]">
        <MuseField
          bare
          label="Search apps"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search connectors"
          value={query}
        />
        <Connections query={query} />
        <ForYourBots query={query} />
        <MuseButton onClick={() => setSettings(!settings)}>
          {settings ? "Close agent settings" : "Personality & memory"}
        </MuseButton>
        {settings ? (
          <>
            <YourAgent />
            <Memory />
          </>
        ) : null}
      </div>
    </MuseScreen>
  );
}

/** The same rows, in the same order, as OpenBot's Connections page builds them. */
function Connections({ query }: { query: string }) {
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const links = useQuery(linkedAccountsQueryOptions());
  const providers = useQuery(identityProvidersQueryOptions());
  if (plugins.isPending || connections.isPending) return null;
  if (plugins.error || connections.error) {
    return (
      <ErrorNotice error="Couldn't load your connections. Reload the page." />
    );
  }
  const connected = new Set(
    personalConnections(connections.data.connections ?? []).map(
      (row) => row.serverId,
    ),
  );
  const added = new Set(plugins.data.servers.map((server) => server.id));
  const listed = serversListedFor(plugins.data);
  const rows = connectionRows({
    catalogue: plugins.data.catalogue.filter(
      (entry) => entry.auth === "user-oauth" && added.has(entry.key),
    ),
    brokered: brokeredAccountsListedOn(listed),
    shared: sharedAccountsListedOn(listed),
    connected,
    links: links.data ?? [],
    providers: providers.data,
  });
  const needle = query.trim().toLocaleLowerCase();
  const matching = rows.filter((row) =>
    `${row.title} ${row.summary}`.toLocaleLowerCase().includes(needle),
  );
  if (rows.length === 0) {
    return (
      <p className={museText.muted}>
        Apps show up here once an admin turns them on.
      </p>
    );
  }
  if (matching.length === 0) {
    return <p className={museText.muted}>No matching connectors.</p>;
  }
  const groups = [
    {
      title: "Connected",
      rows: matching.filter((row) => row.state !== "available"),
    },
    {
      title: "Available integrations",
      rows: matching.filter((row) => row.state === "available"),
    },
  ].filter((group) => group.rows.length);
  return (
    <div className="flex flex-col gap-[22px]">
      {groups.map((group) => (
        <section className="flex flex-col gap-2" key={group.title}>
          <h2 className={cn(museText.small, "ml-3")}>{group.title}</h2>
          <div className="rounded-[23px] bg-[var(--openmuse-group)] px-4">
            {group.rows.map((row, index) => (
              <Item
                aria-label={`Manage ${row.title}`}
                className={cn(
                  "min-h-[61px] flex-nowrap gap-3.5 rounded-none border-0 px-0 py-2 [a]:hover:bg-transparent",
                  index < group.rows.length - 1 &&
                    "border-[var(--openmuse-group-line)] border-b",
                )}
                key={row.key}
                render={
                  <Link params={{ key: row.key }} to="/connections/$key" />
                }
              >
                <span className="flex size-[29px] shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-card text-foreground [&_img]:size-[22px]">
                  <ConnectionMark mark={row.mark} />
                </span>
                <span className={cn(museText.body, "min-w-0 flex-1 truncate")}>
                  {row.title}
                </span>
                {row.state === "connected" ? (
                  <IconChevronRight
                    aria-hidden="true"
                    className="size-[18px] shrink-0 text-[var(--openmuse-quiet)]"
                  />
                ) : row.state === "team" ? (
                  <span className={museText.small}>Team account</span>
                ) : (
                  <span className="text-[13px] text-[var(--openmuse-accent)]">
                    {row.state === "needs_reconnect" ? "Reconnect" : "Connect"}
                  </span>
                )}
              </Item>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const MARKS: Record<string, typeof IconPlug> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

function ConnectionMark({ mark }: { mark: ConnectionRow["mark"] }) {
  if (mark.kind === "logo") return <PluginLogo logo={mark.logo} />;
  const Mark =
    mark.kind === "provider"
      ? providerIcon(mark.provider)
      : (MARKS[mark.key] ?? IconPlug);
  return <Mark className="size-[19px]" stroke={1.8} />;
}

/** OpenMuse's "On your computer": here, what the person's Bots can do and keep doing. */
function ForYourBots({ query }: { query: string }) {
  const { bot } = useMuse();
  const rows = [
    {
      key: "skills",
      title: "Skills",
      detail: "What your Bots know how to do",
      icon: IconBox,
      link: <Link to="/capabilities/skills" />,
    },
    {
      key: "memory",
      title: "Memory",
      detail: "What your Bots remember about you",
      icon: IconBrain,
      link: <Link to="/capabilities/memory" />,
    },
    {
      key: "routines",
      title: "Routines",
      detail: "Everything your Bots do on a schedule",
      icon: IconCalendarRepeat,
      link: <Link to="/routines" />,
    },
    ...(bot
      ? [
          {
            key: "responsibilities",
            title: "Responsibilities",
            detail: `What ${bot.name} keeps doing, and what starts it`,
            icon: IconTargetArrow,
            link: (
              <Link
                params={{ agentId: bot.id }}
                to="/bots/$agentId/responsibilities"
              />
            ),
          },
        ]
      : []),
    {
      key: "connections",
      title: "All connections",
      detail: "Connect, reconnect or remove an account",
      icon: IconPlug,
      link: <Link to="/connections" />,
    },
  ].filter((row) =>
    `${row.title} ${row.detail}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className={museText.heading}>For your Bots</h2>
      <MuseCard className="bg-[var(--openmuse-group-soft)] py-[3px]">
        {rows.map((row) => (
          <LinkRow
            detail={row.detail}
            icon={row.icon}
            key={row.key}
            render={row.link}
            title={row.title}
          />
        ))}
      </MuseCard>
    </section>
  );
}

/**
 * OpenMuse's "Your agent". A Bot's name and look are edited on its OpenBot setup page, so this card
 * shows them and goes there.
 */
function YourAgent() {
  const { bot, defaultBotId } = useMuse();
  if (!bot) return null;
  return (
    <MuseCard className="flex flex-col gap-2.5">
      <SectionHeading title="Your agent" />
      <div className="mb-3 flex flex-col items-center gap-2 text-center">
        <span className="rounded-[24px] bg-[var(--openmuse-sky)] p-[7px]">
          <Mascot size={62} tint={mascotTint(bot.id, defaultBotId)} />
        </span>
        <p className={museText.heading}>{bot.name}</p>
        {bot.title ? <p className={museText.small}>{bot.title}</p> : null}
        {bot.roleDescription ? (
          <p className={cn(museText.muted, "max-w-[460px]")}>
            {bot.roleDescription}
          </p>
        ) : null}
      </div>
      <LinkRow
        detail="Name, role, instructions and connection"
        icon={IconUserCircle}
        render={<Link params={{ agentId: bot.id }} to="/bots/$agentId/setup" />}
        title="Bot setup"
      />
      <LinkRow
        detail="Background research, sources and what it formed"
        icon={IconBrain}
        render={
          <Link params={{ agentId: bot.id }} to="/bots/$agentId/memory" />
        }
        title={`${bot.name}'s memory`}
      />
      <LinkRow
        detail="Access, sharing, reach and activity"
        icon={IconSettings}
        render={<Link params={{ agentId: bot.id }} to="/bots/$agentId" />}
        tint="plain"
        title={`${bot.name}'s page`}
      />
    </MuseCard>
  );
}

/** Context the person can inspect, correct or forget: OpenBot's memory, with OpenBot's actions. */
function Memory() {
  const memories = useQuery(memoriesQueryOptions());
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  const [text, setText] = useState("");
  const shown = (memories.data ?? []).slice(0, MEMORIES_SHOWN);
  return (
    <MuseCard className="flex flex-col gap-3">
      <SectionHeading
        action={
          <HeadingLink render={<Link to="/capabilities/memory" />}>
            See all
          </HeadingLink>
        }
        className="mb-0"
        title="Memory"
      />
      <p className={museText.muted}>
        Context you can inspect, correct or forget.
      </p>
      {memories.isPending ? null : memories.error ? (
        <ErrorNotice error={memories.error.message} />
      ) : (
        shown.map((memory) => <MemoryRow key={memory.id} memory={memory} />)
      )}
      <MuseField
        label="Remember something about me"
        onChange={(event) => setText(event.target.value)}
        placeholder="I prefer morning meetings"
        value={text}
      />
      <ErrorNotice error={remember.error?.message} />
      <MuseButton
        disabled={remember.isPending || !text.trim()}
        onClick={() =>
          remember.mutate(text.trim(), { onSuccess: () => setText("") })
        }
      >
        Remember
      </MuseButton>
    </MuseCard>
  );
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.content);
  const when = new Date(memory.updatedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="flex flex-col gap-2 border-border border-b pb-4">
      {editing ? (
        <MuseField
          label="Memory"
          onChange={(event) => setText(event.target.value)}
          value={text}
        />
      ) : (
        <p className={cn(museText.body, "whitespace-pre-wrap")}>
          {memory.content}
        </p>
      )}
      <p className={museText.small}>
        {memory.provenance} · {when}
        {memory.reviewState === "unreviewed" ? " · needs review" : ""}
        {memory.enabled ? "" : " · turned off"}
      </p>
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <MuseButton
            disabled={save.isPending || !text.trim()}
            onClick={() =>
              save.mutate(
                { id: memory.id, input: { content: text.trim() } },
                { onSuccess: () => setEditing(false) },
              )
            }
            small
          >
            Save correction
          </MuseButton>
        ) : (
          <MuseButton onClick={() => setEditing(true)} small>
            Edit
          </MuseButton>
        )}
        {memory.reviewState === "unreviewed" ? (
          <MuseButton
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                id: memory.id,
                input: { reviewState: "confirmed" },
              })
            }
            small
          >
            Confirm
          </MuseButton>
        ) : null}
        <MuseButton
          danger
          disabled={forget.isPending}
          onClick={() => forget.mutate(memory.id)}
          small
        >
          Forget
        </MuseButton>
      </div>
      <ErrorNotice error={save.error?.message ?? forget.error?.message} />
    </div>
  );
}
