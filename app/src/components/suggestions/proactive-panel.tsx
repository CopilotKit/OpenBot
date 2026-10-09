import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  createProactiveSetting,
  type ProactiveSetting,
  proactiveKeys,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  removeProactiveSetting,
  resolveSuggestion,
  runProactiveNow,
  updateProactiveSetting,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";

const field = "grid gap-1 text-sm";
const select = "h-9 rounded-md border bg-background px-3 text-sm";
const intervals = [
  { minutes: 60, label: "Every hour" },
  { minutes: 240, label: "Every 4 hours" },
  { minutes: 720, label: "Twice a day" },
  { minutes: 1440, label: "Once a day" },
];
async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
  ]);
}

/** Next steps a Bot proposed from background research: start one as a task, or dismiss it. */
export function SuggestionsInbox({
  agentId,
}: {
  /** Only this Bot's suggestions, and nothing at all when it has none. */
  agentId?: string;
} = {}) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const shown = (suggestions.data ?? []).filter(
    (suggestion) => agentId === undefined || suggestion.agentId === agentId,
  );
  const bots = useQuery(agentListQueryOptions());
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: refresh,
  });
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? "Your Bot";
  if (agentId !== undefined && shown.length === 0) return null;
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">Suggested next steps</h2>
      {suggestions.isPending ? (
        <p>Loading suggestions…</p>
      ) : suggestions.error ? (
        <p role="alert" className="text-destructive">
          {suggestions.error.message}
        </p>
      ) : shown.length ? (
        shown.map((suggestion) => (
          <article
            key={suggestion.id}
            className="grid gap-2 rounded-lg border p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{suggestion.title}</strong>
              <span className="text-xs text-muted-foreground">
                {botName(suggestion.agentId)} ·{" "}
                {new Date(suggestion.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{suggestion.detail}</p>
            {(suggestion.sourceApp || suggestion.sourceLink) && (
              <p className="text-xs text-muted-foreground">
                From {suggestion.sourceApp ?? "a connected app"}
                {suggestion.sourceLink && (
                  <>
                    {" · "}
                    <a
                      className="underline"
                      href={suggestion.sourceLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open record
                    </a>
                  </>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: suggestion.id, action: "start" })
                }
              >
                Start as task
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: suggestion.id, action: "dismiss" })
                }
              >
                Dismiss
              </Button>
            </div>
          </article>
        ))
      ) : (
        <p className="text-muted-foreground">
          No suggestions right now. Bots with background research on will
          suggest next steps here.
        </p>
      )}
      {act.error && (
        <p role="alert" className="text-destructive">
          {act.error.message}
        </p>
      )}
    </section>
  );
}

/** Opt a Bot in to read-only background research of the apps it can already read. */
export function ProactiveResearchSettings({
  agentId: fixedBot,
}: {
  /** Only this Bot's research, and a new one is this Bot's without asking. */
  agentId?: string;
} = {}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [channelId, setChannelId] = useState("");
  const [focus, setFocus] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(240);
  const id = useId();
  const eligibleChannels = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(agentId),
  );
  const add = useMutation({
    mutationFn: createProactiveSetting,
    onSuccess: async () => {
      setFocus("");
      await refresh();
    },
  });
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">Background research</h2>
      <p className="text-sm text-muted-foreground">
        A Bot you opt in looks through the apps it can already read, forms
        memories for you to review and suggests next steps. It can only read: it
        cannot send messages, change anything in an app, or use a browser or
        computer.
      </p>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate({ agentId, channelId, focus, intervalMinutes });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {fixedBot === undefined ? (
            <label className={field}>
              Bot
              <select
                required
                className={select}
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value);
                  setChannelId("");
                }}
              >
                <option value="">Choose a Bot</option>
                {bots.data?.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={field}>
            Deliver suggestions to
            <select
              required
              className={select}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">Choose a channel</option>
              {eligibleChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {conversationLabel(channel)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            How often
            <select
              className={select}
              value={intervalMinutes}
              onChange={(event) =>
                setIntervalMinutes(Number(event.target.value))
              }
            >
              {intervals.map((interval) => (
                <option key={interval.minutes} value={interval.minutes}>
                  {interval.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={field} htmlFor={`${id}-focus`}>
          What to look for (optional)
          <Input
            id={`${id}-focus`}
            maxLength={1000}
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            placeholder="Open issues assigned to me and questions waiting on me"
          />
        </label>
        <Button
          type="submit"
          className="justify-self-start"
          disabled={add.isPending || !agentId || !channelId}
        >
          Turn on background research
        </Button>
        {add.error && (
          <p role="alert" className="text-destructive">
            {add.error.message}
          </p>
        )}
      </form>
      {settings.error && (
        <p role="alert" className="text-destructive">
          {settings.error.message}
        </p>
      )}
      {settings.data
        ?.filter(
          (setting) => fixedBot === undefined || setting.agentId === fixedBot,
        )
        .map((setting) => (
          <SettingRow
            key={setting.id}
            setting={setting}
            botName={
              bots.data?.find((bot) => bot.id === setting.agentId)?.name ??
              setting.agentId
            }
          />
        ))}
    </section>
  );
}

function SettingRow({
  setting,
  botName,
}: {
  setting: ProactiveSetting;
  botName: string;
}) {
  const change = useMutation({
    mutationFn: (
      action:
        | { kind: "toggle" }
        | { kind: "run" }
        | { kind: "remove" }
        | { kind: "interval"; minutes: number },
    ) =>
      action.kind === "run"
        ? runProactiveNow(setting.id)
        : action.kind === "remove"
          ? removeProactiveSetting(setting.id)
          : updateProactiveSetting(
              setting.id,
              action.kind === "toggle"
                ? { enabled: !setting.enabled }
                : { intervalMinutes: action.minutes },
            ),
    onSuccess: refresh,
  });
  return (
    <article className="grid gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <strong>{botName}</strong>
        <span className="text-sm text-muted-foreground">
          {!setting.enabled
            ? "Off"
            : setting.lastStatus === "running"
              ? "Researching now"
              : `Next ${new Date(setting.nextRunAt).toLocaleString()}`}
        </span>
      </div>
      {setting.focus && <p className="text-sm">{setting.focus}</p>}
      {setting.lastRunAt && (
        <p className="text-xs text-muted-foreground">
          Last ran {new Date(setting.lastRunAt).toLocaleString()}
          {setting.lastStatus === "succeeded" ? "" : ` (${setting.lastStatus})`}
        </p>
      )}
      {setting.lastError && (
        <p role="alert" className="text-destructive">
          {setting.lastError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="How often"
          className={select}
          value={setting.intervalMinutes}
          onChange={(event) =>
            change.mutate({
              kind: "interval",
              minutes: Number(event.target.value),
            })
          }
        >
          {intervals.map((interval) => (
            <option key={interval.minutes} value={interval.minutes}>
              {interval.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!setting.enabled || change.isPending}
          onClick={() => change.mutate({ kind: "run" })}
        >
          Run now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={change.isPending}
          onClick={() => change.mutate({ kind: "toggle" })}
        >
          {setting.enabled ? "Turn off" : "Turn on"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={change.isPending}
          onClick={() => change.mutate({ kind: "remove" })}
        >
          Remove
        </Button>
      </div>
      {change.error && (
        <p role="alert" className="text-destructive">
          {change.error.message}
        </p>
      )}
    </article>
  );
}
