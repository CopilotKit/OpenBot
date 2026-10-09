import {
  IconBulb,
  IconChevronRight,
  IconClock,
  IconPlus,
  IconRadar,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
  ItemFooter,
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

const intervals = [
  { minutes: 60, label: "Every hour" },
  { minutes: 240, label: "Every 4 hours" },
  { minutes: 720, label: "Twice a day" },
  { minutes: 1440, label: "Once a day" },
];
/** The label map, so a closed trigger says "Every 4 hours" rather than 240. */
const intervalItems = intervals.map((interval) => ({
  value: interval.minutes,
  label: interval.label,
}));
const intervalLabel = (minutes: number) =>
  intervals.find((interval) => interval.minutes === minutes)?.label ??
  `Every ${minutes} minutes`;
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
    <PageSection title="Suggested next steps">
      {suggestions.isPending ? null : suggestions.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {suggestions.error.message}
        </p>
      ) : shown.length ? (
        <PageRows>
          {shown.map((suggestion, index) => (
            <Fragment key={suggestion.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBulb />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="line-clamp-none">
                    {suggestion.title}
                  </ItemTitle>
                  {suggestion.detail ? (
                    <ItemDescription className="line-clamp-none whitespace-pre-wrap text-foreground">
                      {suggestion.detail}
                    </ItemDescription>
                  ) : null}
                  <ItemDescription className="line-clamp-none">
                    {botName(suggestion.agentId)} ·{" "}
                    {new Date(suggestion.createdAt).toLocaleString()}
                    {suggestion.sourceApp || suggestion.sourceLink ? (
                      <>
                        {" · "}From {suggestion.sourceApp ?? "a connected app"}
                        {suggestion.sourceLink && (
                          <>
                            {" · "}
                            <a
                              href={suggestion.sourceLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open record
                            </a>
                          </>
                        )}
                      </>
                    ) : null}
                  </ItemDescription>
                  {/* A set, so it wraps onto its own line rather than crowding the title. */}
                  <ItemFooter>
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
                  </ItemFooter>
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty>
          No suggestions right now. Bots with background research on will
          suggest next steps here.
        </PageEmpty>
      )}
      {act.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {act.error.message}
        </p>
      )}
    </PageSection>
  );
}

/**
 * Opt a Bot in to read-only background research of the apps it can already read.
 *
 * Each opt-in is a row stating its current answer; it opens a dialog to change how often, run it,
 * turn it off or remove it. Opting in is a dialog behind the section's action.
 */
export function ProactiveResearchSettings({
  agentId: fixedBot,
}: {
  /** Only this Bot's research, and a new one is this Bot's without asking. */
  agentId?: string;
} = {}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [adding, setAdding] = useState(false);
  const shown = (settings.data ?? []).filter(
    (setting) => fixedBot === undefined || setting.agentId === fixedBot,
  );
  return (
    <PageSection
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          Turn on research
        </Button>
      }
      description="A Bot you opt in looks through the apps it can already read, forms memories for you to review and suggests next steps. It can only read: it cannot send messages, change anything in an app, or use a browser or computer."
      title="Background research"
    >
      {settings.isPending ? null : settings.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {settings.error.message}
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty>Background research is off.</PageEmpty>
      ) : (
        <PageRows>
          {shown.map((setting, index) => (
            <Fragment key={setting.id}>
              {index > 0 ? <Separator /> : null}
              <SettingRow
                setting={setting}
                botName={
                  bots.data?.find((bot) => bot.id === setting.agentId)?.name ??
                  setting.agentId
                }
              />
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? (
        <TurnOnResearchDialog
          fixedBot={fixedBot}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </PageSection>
  );
}

/** Which Bot, where its suggestions go, how often, and what to look for. */
function TurnOnResearchDialog({
  fixedBot,
  onClose,
}: {
  fixedBot?: string;
  onClose: () => void;
}) {
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
      onClose();
      await refresh();
    },
  });
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn on background research</DialogTitle>
          <DialogDescription>
            It reads on a schedule and delivers what it suggests to a channel it
            is in.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={id}
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate({ agentId, channelId, focus, intervalMinutes });
            }}
          >
            <FieldGroup>
              {fixedBot === undefined ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-bot`}>Bot</FieldLabel>
                  <Select
                    items={bots.data?.map((bot) => ({
                      value: bot.id,
                      label: bot.name,
                    }))}
                    onValueChange={(value) => {
                      setAgentId(value ?? "");
                      setChannelId("");
                    }}
                    required
                    value={agentId || null}
                  >
                    <SelectTrigger className="w-full" id={`${id}-bot`}>
                      <SelectValue placeholder="Choose a Bot" />
                    </SelectTrigger>
                    <SelectContent>
                      {bots.data?.map((bot) => (
                        <SelectItem key={bot.id} value={bot.id}>
                          {bot.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${id}-channel`}>
                  Deliver suggestions to
                </FieldLabel>
                <Select
                  items={eligibleChannels.map((channel) => ({
                    value: channel.id,
                    label: conversationLabel(channel),
                  }))}
                  onValueChange={(value) => setChannelId(value ?? "")}
                  required
                  value={channelId || null}
                >
                  <SelectTrigger className="w-full" id={`${id}-channel`}>
                    <SelectValue placeholder="Choose a channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleChannels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {conversationLabel(channel)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-interval`}>How often</FieldLabel>
                <Select
                  items={intervalItems}
                  onValueChange={(value) => {
                    if (value !== null) setIntervalMinutes(value);
                  }}
                  value={intervalMinutes}
                >
                  <SelectTrigger className="w-full" id={`${id}-interval`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {intervals.map((interval) => (
                      <SelectItem
                        key={interval.minutes}
                        value={interval.minutes}
                      >
                        {interval.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-focus`}>
                  What to look for (optional)
                </FieldLabel>
                <Input
                  id={`${id}-focus`}
                  maxLength={1000}
                  value={focus}
                  onChange={(event) => setFocus(event.target.value)}
                  placeholder="Open issues assigned to me and questions waiting on me"
                />
              </Field>
            </FieldGroup>
          </form>
          {add.error && (
            <p role="alert" className="text-destructive text-sm">
              {add.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={add.isPending || !agentId || !channelId}
            form={id}
            size="sm"
            type="submit"
          >
            Turn on background research
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Whether it is on, and when it runs next. Stated rather than captured, so it follows the query. */
function researchStatus(setting: ProactiveSetting) {
  return !setting.enabled
    ? "Off"
    : setting.lastStatus === "running"
      ? "Researching now"
      : `Next ${new Date(setting.nextRunAt).toLocaleString()}`;
}

/**
 * One Bot's research: a summary of its current answer and a chevron, opening a dialog that changes
 * it. The dialog is the row's sibling, not its child, so a click inside it does not bubble back to
 * the row and reopen it.
 */
function SettingRow({
  setting,
  botName,
}: {
  setting: ProactiveSetting;
  botName: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
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
  const summary = [
    setting.focus,
    intervalLabel(setting.intervalMinutes),
    researchStatus(setting),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconRadar />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{botName}</ItemTitle>
          <ItemDescription>{summary}</ItemDescription>
          {setting.lastError ? (
            <ItemDescription className="text-destructive">
              {setting.lastError}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Background research</DialogTitle>
            <DialogDescription>
              {setting.focus ? `${botName} · ${setting.focus}` : botName}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Item size="sm" variant="muted">
              <ItemMedia variant="icon">
                <IconClock />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{researchStatus(setting)}</ItemTitle>
                {setting.lastRunAt && (
                  <ItemDescription>
                    Last ran {new Date(setting.lastRunAt).toLocaleString()}
                    {setting.lastStatus === "succeeded"
                      ? ""
                      : ` (${setting.lastStatus})`}
                  </ItemDescription>
                )}
              </ItemContent>
            </Item>
            {setting.lastError && (
              <p role="alert" className="text-destructive text-sm">
                {setting.lastError}
              </p>
            )}
            <Field>
              <FieldLabel htmlFor={`${id}-interval`}>How often</FieldLabel>
              {/* Writes on pick: one value, no draft worth holding. */}
              <Select
                disabled={change.isPending}
                items={intervalItems}
                onValueChange={(minutes) => {
                  if (minutes !== null && minutes !== setting.intervalMinutes)
                    change.mutate({ kind: "interval", minutes });
                }}
                value={setting.intervalMinutes}
              >
                <SelectTrigger className="w-full" id={`${id}-interval`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intervals.map((interval) => (
                    <SelectItem key={interval.minutes} value={interval.minutes}>
                      {interval.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {change.error && (
              <p role="alert" className="text-destructive text-sm">
                {change.error.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() =>
                change.mutate(
                  { kind: "remove" },
                  { onSuccess: () => setOpen(false) },
                )
              }
            >
              Remove
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
              disabled={!setting.enabled || change.isPending}
              onClick={() => change.mutate({ kind: "run" })}
            >
              Run now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
