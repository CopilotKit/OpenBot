import {
  IconArrowUpRight,
  IconDots,
  IconRadar,
  IconX,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  changeProactiveSettingMutationOptions,
  type ProactiveSetting,
  type ProactiveSuggestion,
  resolveSuggestionMutationOptions,
  sourceSite,
} from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/**
 * One thing a Bot's check-in found: what it is, a line of why, where it was read, and what to do
 * about it.
 *
 * - Work on it makes it a task in a conversation of its own with the Bot.
 * - ✕ dismisses it, and the Bot is told not to raise it, or things like it, for 30 days.
 * - The menu's Stop checking this turns off the check-in that found it, for a find the person does
 *   not want more of at all.
 *
 * The detail is cut to a line and opens on a click on the row's text, so a list of several reads at
 * a glance. Which Bot found it is the group's header where the row sits in one (`inGroup`), and said
 * on the row otherwise.
 *
 * Each row has its own request, so dismissing one leaves the others' buttons alone.
 */
export function SuggestionRow({
  suggestion,
  botName,
  setting,
  inGroup = false,
}: {
  suggestion: ProactiveSuggestion;
  /** The Bot it came from, said on the row unless the row sits under that Bot's header. */
  botName: string;
  /** The check-in that found it, when it is still there to turn off. */
  setting?: ProactiveSetting;
  inGroup?: boolean;
}) {
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const stop = useMutation(changeProactiveSettingMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const pressed = act.isPending ? act.variables.action : null;
  const site = suggestion.sourceLink ? sourceSite(suggestion.sourceLink) : null;
  const initial = (suggestion.sourceApp ?? "").trim().charAt(0).toUpperCase();
  const error = act.error ?? stop.error;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {initial ? (
          <span aria-hidden className="font-medium text-xs">
            {initial}
          </span>
        ) : (
          <IconRadar />
        )}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <button
          aria-expanded={open}
          className="min-w-0 cursor-pointer text-left"
          onClick={() => setOpen(!open)}
          type="button"
        >
          <ItemTitle className="line-clamp-none">{suggestion.title}</ItemTitle>
          {suggestion.detail ? (
            <ItemDescription
              className={
                open ? "line-clamp-none whitespace-pre-wrap" : "line-clamp-1"
              }
            >
              {suggestion.detail}
            </ItemDescription>
          ) : null}
        </button>
        <ItemDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {suggestion.sourceApp ? (
            <span className="rounded-full border border-border px-1.5 py-px">
              {suggestion.sourceApp}
            </span>
          ) : null}
          {inGroup ? null : <span>{botName}</span>}
          <span>{relativeTime(suggestion.createdAt)}</span>
          {suggestion.sourceLink ? (
            <a
              className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
              href={suggestion.sourceLink}
              rel="noreferrer"
              target="_blank"
            >
              {site ? `Open ${site}` : "Open"}
              <IconArrowUpRight aria-hidden className="size-3" />
            </a>
          ) : null}
        </ItemDescription>
        {error ? (
          <p className="mt-1 text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="self-start">
        <Button
          disabled={act.isPending}
          onClick={() => act.mutate({ id: suggestion.id, action: "start" })}
          size="sm"
          variant="outline"
        >
          {pressed === "start" ? "Starting…" : "Work on it"}
        </Button>
        <Button
          aria-label={`Dismiss ${suggestion.title}`}
          disabled={act.isPending}
          onClick={() => act.mutate({ id: suggestion.id, action: "dismiss" })}
          size="icon-sm"
          variant="ghost"
        >
          <IconX />
        </Button>
        {setting?.enabled ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`More for ${suggestion.title}`}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <IconDots />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={stop.isPending}
                onClick={() =>
                  stop.mutate({ setting, change: { kind: "toggle" } })
                }
              >
                {setting.subject
                  ? `Stop checking ${setting.subject}`
                  : "Stop these check-ins"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </ItemActions>
    </Item>
  );
}
