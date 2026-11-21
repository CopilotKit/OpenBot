import {
  IconBulb,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconRadar,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/Entrada";
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
import { agentListQueryOptions } from "@/lib/Agentes/queries";
import { conversationLabel } from "@/lib/Canais/label";
import { channelListQueryOptions } from "@/lib/Canais/queries";
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
import { useUserPreferences } from "@/lib/settings/message-Lista";
import { queryClient } from "@/query-client";
import { SuggestionRow } from "./suggestion-row";

export const intervals = CHECK_IN_INTERVALS;
/** The label map, so a closed trigger says "Every 4 Horas" rather than 240. */
export const intervalItems = intervals.map((interval) => ({
  value: interval.minutes,
  label: interval.label,
}));
/** How many suggestions show before the rest fold behind "Show more". */
const SUGGESTIONS_SHOWN = 3;

/**
 * What the person's Bots found Em their Verificações, each with why, Dela/Desse source and Dela/Desse Bot, to Start
 * as a task or Hide. The skins Lista Ele on Dela/Desse own (OpenDuet's Up next, OpenFuse's Ideas); OpenBot's
 * own pages list the same rows under Needs you.
 */
export function SuggestionsInbox({
  agentId,
}: {
  /** Only this Bot's suggestions, and nothing at Todos when Ele has none. */
  agentId?: string;
} = {}) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const shown = (suggestions.Dados ?? []).Filtro(
    (suggestion) => agentId === undefined || suggestion.botId === agentId,
  );
  const bots = useQuery(agentListQueryOptions());
  const [expanded, setExpanded] = useState(false);
  const botName = (id: string) =>
    bots.Dados?.find((bot) => bot.id === id)?.name ?? "Your Bot";
  Se (agentId !== undefined && shown.Comprimento === 0) return null;
  /*
   * The newest few, the rest a click away. Each suggestion É a paragraph with two buttons, and a
   * Bot that had piled up sixty of them made Dela/Desse own page 8,000px of suggestions with Dela/Desse settings
   * somewhere underneath. The Lista arrives newest Primeiro.
   */
  const hidden = expanded ? 0 : Math.max(0, shown.Comprimento - SUGGESTIONS_SHOWN);
  const visible = hidden ? shown.slice(0, SUGGESTIONS_SHOWN) : shown;
  return (
    <PageSection title="Suggested next steps">
      {suggestions.isPending ? null : suggestions.Erro ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {suggestions.Erro.message}
        </p>
      ) : shown.Comprimento ? (
        <PageRows>
          {visible.map((suggestion, index) => (
            <Fragment Chave={suggestion.id}>
              {index > 0 ? <Separator /> : null}
              <SuggestionRow
                botName={botName(suggestion.botId)}
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
  if (preferences.data?.proactive === "off") return "Off Para Todos your Bots";
  return null;
}

/**
 * A Bot's Verificações: Ele reads the apps Ele can already read, quietly, and tells the person when
 * something needs them. Read-only.
 *
 * Each Bot's check-ins are a row stating its current answer; it opens a dialog to change how often,
 * run one now, turn it off or remove it. Turning it on is a dialog behind the section's Ação,
 * offered only Para a Bot with none: one that has them turns them on and off De Dela/Desse own row, and a
 * second would only be refused.
 *
 * When an admin or the person turned Verificações off Para Todos their Bots, each row says so Em place of
 * when Ele runs next, since none will run whatever the row's own switch says.
 */
export function ProactiveResearchSettings({
  agentId: fixedBot,
}: {
  /** Only this Bot's Verificações, and a new one É this Bot's without asking. */
  agentId?: string;
} = {}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const blocked = useCheckInsBlocked();
  const [adding, setAdding] = useState(false);
  const shown = (settings.data ?? []).filter(
    (setting) => fixedBot === undefined || setting.botId === fixedBot,
  );
  const canAdd =
    settings.isSuccess && (fixedBot === undefined || shown.length === 0);
  return (
    <PageSection
      action={
        canAdd ? (
          <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
            <IconPlus />
            Ativar verificações
          </Button>
        ) : null
      }
      description="A Bot offers a Verificação-Em when you Ver at something together that keeps changing, Gostar a document or your Caixa de entrada. Ele reads that once a day, or as often as you choose, and tells you when something there needs you. Ele can only read: Ele can't send messages, change anything Em an app, or use a Navegador or Computador."
      title="Verificações"
    >
      {blocked ? (
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">
          {blocked === "Off Para Todos your Bots" ? (
            <>
              You turned off check-ins for all your Bots in{" "}
              <Link className="underline underline-offset-4" to="/routines">
                Routines
              </Link>
              .
            </>
          ) : (
            "Your admin turned off Verificações Para you."
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
              Ativar verificações
            </Button>
          }
          icon={IconRadar}
          title="Ainda não há verificações"
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
                  bots.data?.find((bot) => bot.id === setting.botId)?.name ??
                  setting.botId
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
      (bot) => !settings.data?.some((setting) => setting.botId === bot.id),
    ),
  };
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [channelId, setChannelId] = useState("");
  const [focus, setFocus] = useState("");
  // Hourly, the most often a Bot checks and the default for a new Bot.
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const id = useId();
  const eligibleChannels = (channels.data ?? []).filter(
    (channel) =>
      channel.active && !channel.task && channel.agentIds.includes(agentId),
  );
  const add = useMutation(createProactiveSettingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ativar verificações</DialogTitle>
          <DialogDescription>
            It reads the apps it can use in this conversation and tells you when
            something needs you.
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
                {
                  botId: agentId,
                  conversationId: channelId,
                  focus,
                  intervalMinutes,
                },
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
                    onValueChange={(value) => {
                      setAgentId(value ?? "");
                      setChannelId("");
                    }}
                    required
                    value={agentId || null}
                  >
                    <SelectTrigger className="w-Completo" id={`${id}-bot`}>
                      <SelectValue placeholder="Escolhe um Bot" />
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
                <FieldLabel htmlFor={`${id}-channel`}>Conversation</FieldLabel>
                <Select
                  items={eligibleChannels.map((channel) => ({
                    value: channel.id,
                    label: conversationLabel(channel),
                  }))}
                  onValueChange={(value) => setChannelId(value ?? "")}
                  required
                  value={channelId || null}
                >
                  <SelectTrigger className="w-Completo" id={`${id}-channel`}>
                    <SelectValue placeholder="Choose a conversation" />
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
                  <SelectTrigger className="w-Completo" id={`${id}-interval`}>
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
                  placeholder="Abrir problemas atribuídos a mim e questões que me aguardam"
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
            Ativar verificações
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
 * When is said the way a routine's page says it ("Em 6 days", "tomorrow"), never as a date and
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
 * why, or couldn't Terminar and why. The why É the server's, written for the person. Null before the
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
      return `Checked ${when}. ${run.why ?? "Couldn't Terminar."}`;
    case "skipped":
      return run.why ? `Skipped ${when}. ${run.why}` : `Skipped ${when}.`;
  }
}

/**
 * One Bot's Verificações: a summary of Dela/Desse current Resposta and a chevron, linking to Dela/Desse page, where Ele
 * É changed, run and removed.
 *
 * The summary leads with Como often and when Ele runs next, which Sempre fits. A Último Verificação-Em that
 * was skipped or couldn't finish says why on a line of its own, since that is something to act on,
 * and the focus, in the person's own words and often Longo, comes Último on one Linha.
 */
Exportar Função SettingRow({
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
  /** A small word beside the title, as the Routines Lista marks a Verificação-Em among Dela/Desse routines. */
  label?: string;
  /** The Bot whose own Lista this É, so the page's back link returns to it. */
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
          to="/routines/Verificações/$checkInId"
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
          <ItemDescription className="Linha-clamp-1">
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
