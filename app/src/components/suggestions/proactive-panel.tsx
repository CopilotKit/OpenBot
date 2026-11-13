import {
  IconBulb,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconRadar,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import {
  createProactiveSettingMutationOptions,
  type LastCheckIn,
  type ProactiveSetting,
  proactiveAllowedQueryOptions,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
} from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { CHECK_IN_INTERVALS, intervalLabel } from "@/lib/routines/merged";
import { useUserPreferences } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { SuggestionRow } from "./suggestion-row";

export const intervals = CHECK_IN_INTERVALS;
/** The label map, so a closed trigger says "Every 4 hours" rather than 240. */
export const intervalItems = intervals.map((interval) => ({
  value: interval.minutes,
  label: interval.label,
}));
/** How many suggestions show before the rest fold behind "Show more". */
const SUGGESTIONS_SHOWN = 3;

/**
 * What the person's Bots found in their check-ins, each with why, its source and its Bot, to Start
 * as a task or Hide. The skins list it on its own (OpenDuet's Up next, OpenFuse's Ideas); OpenBot's
 * own pages list the same rows under Needs you.
 */
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
  const [expanded, setExpanded] = useState(false);
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? "Your Bot";
  if (agentId !== undefined && shown.length === 0) return null;
  /*
   * The newest few, the rest a click away. Each suggestion is a paragraph with two buttons, and a
   * Bot that had piled up sixty of them made its own page 8,000px of suggestions with its settings
   * somewhere underneath. The list arrives newest first.
   */
  const hidden = expanded ? 0 : Math.max(0, shown.length - SUGGESTIONS_SHOWN);
  const visible = hidden ? shown.slice(0, SUGGESTIONS_SHOWN) : shown;
  return (
    <PageSection title="Suggested next steps">
      {suggestions.isPending ? null : suggestions.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {suggestions.error.message}
        </p>
      ) : shown.length ? (
        <PageRows>
          {visible.map((suggestion, index) => (
            <Fragment key={suggestion.id}>
              {index > 0 ? <Separator /> : null}
              <SuggestionRow
                botName={botName(suggestion.agentId)}
                suggestion={suggestion}
              />
            </Fragment>
          ))}
          {hidden ? (
            <>
              <Separator />
              <Item
                render={<button type="button" />}
                onClick={() => setExpanded(true)}
                size="sm"
              >
                <ItemContent>
                  <ItemTitle className="text-muted-foreground">
                    Show {hidden} more
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <IconChevronDown className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      ) : (
        <PageEmpty icon={IconBulb} title="Nothing needs you right now">
          When a Bot's check-in finds something that needs you, it shows up
          here.
        </PageEmpty>
      )}
    </PageSection>
  );
}

/**
 * Why no Bot checks in for this person whatever its own setting says, or null when they do: an
 * admin turned check-ins off for them, or they turned them off for all their Bots.
 */
export function useCheckInsBlocked(): string | null {
  const allowed = useQuery(proactiveAllowedQueryOptions());
  const preferences = useUserPreferences();
  if (allowed.data === false) return "Turned off by your admin";
  if (preferences.data?.proactive === "off") return "Off for all your Bots";
  return null;
}

/**
 * A Bot's check-ins: it reads the apps it can already read, quietly, and tells the person when
 * something needs them. Read-only.
 *
 * Each Bot's check-ins are a row stating its current answer; it opens a dialog to change how often,
 * run one now, turn it off or remove it. Turning it on is a dialog behind the section's action,
 * offered only for a Bot with none: one that has them turns them on and off from its own row, and a
 * second would only be refused.
 *
 * When an admin or the person turned check-ins off for all their Bots, each row says so in place of
 * when it runs next, since none will run whatever the row's own switch says.
 */
export function ProactiveResearchSettings({
  agentId: fixedBot,
}: {
  /** Only this Bot's check-ins, and a new one is this Bot's without asking. */
  agentId?: string;
} = {}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const blocked = useCheckInsBlocked();
  const [adding, setAdding] = useState(false);
  const shown = (settings.data ?? []).filter(
    (setting) => fixedBot === undefined || setting.agentId === fixedBot,
  );
  const canAdd =
    settings.isSuccess && (fixedBot === undefined || shown.length === 0);
  return (
    <PageSection
      action={
        canAdd ? (
          <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
            <IconPlus />
            Turn on check-ins
          </Button>
        ) : null
      }
      description="A Bot offers a check-in when you look at something together that keeps changing, like a document or your inbox. It reads that once a day, or as often as you choose, and tells you when something there needs you. It can only read: it can't send messages, change anything in an app, or use a browser or computer."
      title="Check-ins"
    >
      {blocked ? (
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">
          {blocked === "Off for all your Bots" ? (
            <>
              You turned off check-ins for all your Bots in{" "}
              <Link className="underline underline-offset-4" to="/routines">
                Routines
              </Link>
              .
            </>
          ) : (
            "Your admin turned off check-ins for you."
          )}
        </p>
      ) : null}
      {settings.isPending ? null : settings.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {settings.error.message}
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty
          action={
            <Button onClick={() => setAdding(true)} size="sm" variant="outline">
              <IconPlus />
              Turn on check-ins
            </Button>
          }
          icon={IconRadar}
          title="No check-ins yet"
        />
      ) : (
        <PageRows>
          {shown.map((setting, index) => (
            <Fragment key={setting.id}>
              {index > 0 ? <Separator /> : null}
              <SettingRow
                blocked={blocked}
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

/**
 * Which Bot, which conversation it checks from, how often, and what to look for. Only Bots without
 * check-ins, and only the person's own conversations with the Bot: a task's conversation holds one
 * piece of work, and is no place for check-ins to reach them.
 */
export function TurnOnResearchDialog({
  fixedBot,
  onClose,
}: {
  fixedBot?: string;
  onClose: () => void;
}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const allBots = useQuery(agentListQueryOptions());
  const bots = {
    data: allBots.data?.filter(
      (bot) => !settings.data?.some((setting) => setting.agentId === bot.id),
    ),
  };
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [focus, setFocus] = useState("");
  // Hourly, the most often a Bot checks and the default for a new Bot.
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const id = useId();
  const add = useMutation(createProactiveSettingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn on check-ins</DialogTitle>
          <DialogDescription>
            It reads the apps it can use and tells you under Needs you when
            something there needs you.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={id}
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate(
                { agentId, focus, intervalMinutes },
                { onSuccess: onClose },
              );
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
                    onValueChange={(value) => setAgentId(value ?? "")}
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
            disabled={add.isPending || !agentId}
            form={id}
            size="sm"
            type="submit"
          >
            Turn on check-ins
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether it is on, and when it runs next. Stated rather than captured, so it follows the query.
 * While check-ins are off for all the person's Bots, that is the answer, whatever this one says.
 *
 * When is said the way a routine's page says it ("in 6 days", "tomorrow"), never as a date and
 * time. A time already past is one the scheduler hasn't picked up yet, so it is due, not "ago".
 */
export function checkInStatus(
  setting: ProactiveSetting,
  blocked: string | null,
) {
  if (!setting.enabled) return "Off";
  if (blocked) return blocked;
  if (setting.lastStatus === "running") return "Checking now";
  return Date.parse(setting.nextRunAt) <= Date.now()
    ? "Next check due"
    : `Next check ${relativeTime(setting.nextRunAt)}`;
}

/** When a check-in happened, as its line says it: "just now" for the moment after a Run now. */
const sinceThen = (iso: string) =>
  Date.now() - Date.parse(iso) < 60_000 ? "just now" : relativeTime(iso);

/**
 * What the Bot's last check-in did, in a sentence: found nothing, found something, was skipped and
 * why, or couldn't finish and why. The why is the server's, written for the person. Null before the
 * first one.
 */
export function lastCheckInLine(run: LastCheckIn | null | undefined) {
  if (!run) return null;
  const when = sinceThen(run.startedAt);
  switch (run.outcome) {
    case "running":
      return `Started ${when}.`;
    case "quiet":
      return `Checked ${when}. Nothing needed you.`;
    case "raised":
      return `Checked ${when}. Found ${run.itemsRaised === 1 ? "1 thing" : `${run.itemsRaised} things`} for you.`;
    case "failed":
      return `Checked ${when}. ${run.why ?? "Couldn't finish."}`;
    case "skipped":
      return run.why ? `Skipped ${when}. ${run.why}` : `Skipped ${when}.`;
  }
}

/**
 * One Bot's check-ins: a summary of its current answer and a chevron, linking to its page, where it
 * is changed, run and removed.
 *
 * The summary leads with how often and when it runs next, which always fits. A last check-in that
 * was skipped or couldn't finish says why on a line of its own, since that is something to act on,
 * and the focus, in the person's own words and often long, comes last on one line.
 */
export function SettingRow({
  setting,
  botName,
  blocked,
  showBot = true,
  label,
  agentId,
}: {
  setting: ProactiveSetting;
  botName: string;
  blocked: string | null;
  /** Off on one Bot's own list, where every row is that Bot's. */
  showBot?: boolean;
  /** A small word beside the title, as the Routines list marks a check-in among its routines. */
  label?: string;
  /** The Bot whose own list this is, so the page's back link returns to it. */
  agentId?: string;
}) {
  // When it starts, what it does, and where it stands: the Routines list's sentence for a check-in.
  const summary = `${intervalLabel(setting.intervalMinutes)} · Tells you · ${checkInStatus(setting, blocked)}`;
  const last = lastCheckInLine(setting.lastRun);
  const outcome = setting.lastRun?.outcome;
  return (
    <Item
      render={
        <Link
          params={{ checkInId: setting.id }}
          search={agentId ? { agentId } : {}}
          to="/routines/check-ins/$checkInId"
        />
      }
      size="sm"
    >
      <ItemMedia variant="icon">
        <IconRadar />
      </ItemMedia>
      <ItemContent>
        {/* What it watches leads, where it watches one thing; the Bot is who watches it. */}
        <ItemTitle>
          {setting.subject || botName}
          {label ? (
            <span className="font-normal text-muted-foreground text-xs">
              {label}
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          {setting.subject && showBot ? `${botName} · ${summary}` : summary}
        </ItemDescription>
        {last && (outcome === "skipped" || outcome === "failed") ? (
          <ItemDescription
            className={outcome === "failed" ? "text-destructive" : undefined}
          >
            {last}
          </ItemDescription>
        ) : null}
        {setting.focus ? (
          <ItemDescription className="line-clamp-1">
            Looks for: {setting.focus}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
