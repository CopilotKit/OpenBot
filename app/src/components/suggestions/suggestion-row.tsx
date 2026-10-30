import { IconBulb, IconExternalLink } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  type ProactiveSuggestion,
  resolveSuggestionMutationOptions,
  sourceSite,
} from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/**
 * One thing a Bot's check-in found that needs the person: what it is, why, which Bot found it and
 * where it read that, with Start and Hide.
 *
 * Start makes it a task in a conversation of its own; Hide takes it off the list and the Bot is told
 * not to raise it, or things like it, for 30 days. Either takes it off every list at once. Open goes
 * to the record the Bot read, when it gave a link, and names the site it opens: "From" already
 * names the app it was read with.
 *
 * Each row has its own request, so hiding one leaves the others' buttons alone.
 */
export function SuggestionRow({
  suggestion,
  botName,
}: {
  suggestion: ProactiveSuggestion;
  /** The Bot it came from. Named on every list, since one ping folds several Bots' items. */
  botName: string;
}) {
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const pressed = act.isPending ? act.variables.action : null;
  const site = suggestion.sourceLink ? sourceSite(suggestion.sourceLink) : null;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconBulb />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">{suggestion.title}</ItemTitle>
        {suggestion.detail ? (
          <ItemDescription className="line-clamp-none whitespace-pre-wrap text-foreground">
            {suggestion.detail}
          </ItemDescription>
        ) : null}
        <ItemDescription className="line-clamp-none">
          {[
            botName,
            suggestion.sourceApp ? `From ${suggestion.sourceApp}` : null,
            relativeTime(suggestion.createdAt),
          ]
            .filter(Boolean)
            .join(" · ")}
        </ItemDescription>
        {/* A set, so it wraps onto its own line under the text rather than crowding the title. */}
        <ItemFooter className="mt-2 flex-wrap justify-start">
          <Button
            disabled={act.isPending}
            onClick={() => act.mutate({ id: suggestion.id, action: "start" })}
            size="sm"
          >
            {pressed === "start" ? "Starting…" : "Start"}
          </Button>
          <Button
            disabled={act.isPending}
            onClick={() => act.mutate({ id: suggestion.id, action: "dismiss" })}
            size="sm"
            variant="outline"
          >
            {pressed === "dismiss" ? "Hiding…" : "Hide"}
          </Button>
          {suggestion.sourceLink ? (
            <Button
              render={
                <a
                  href={suggestion.sourceLink}
                  rel="noreferrer"
                  target="_blank"
                />
              }
              size="sm"
              variant="ghost"
            >
              {site ? `Open ${site}` : "Open"}
              <IconExternalLink data-icon="inline-end" />
            </Button>
          ) : null}
        </ItemFooter>
        {act.error ? (
          <p className="mt-1 text-destructive text-sm" role="alert">
            {act.error.message}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  );
}
