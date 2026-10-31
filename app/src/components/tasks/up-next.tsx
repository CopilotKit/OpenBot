import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  type ProactiveSuggestion,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";
import { TaskSection } from "./task-section";

/**
 * Up next: what nobody has started yet, which is every Bot's open suggestions from background
 * research. Start opens one as a task of its own and opens its page; Dismiss puts it away.
 *
 * Nothing at all while there are none: the list above already says how tasks arrive.
 */
export function UpNext({
  bots,
}: {
  bots: readonly AgentProfile[] | undefined;
}) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const router = useRouter({ warn: false });
  if (suggestions.isPending) return null;
  if (suggestions.error)
    return (
      <TaskSection label="Up next">
        <p className="px-3 text-destructive text-sm" role="alert">
          Couldn't load Up next. Reload the page.
        </p>
      </TaskSection>
    );
  const open = suggestions.data;
  if (open.length === 0) return null;
  const botOf = (id: string) => bots?.find((bot) => bot.id === id);
  return (
    <TaskSection count={open.length} label="Up next">
      <ul className="flex flex-col gap-1">
        {open.map((suggestion) => (
          <li key={suggestion.id}>
            <UpNextRow
              bot={botOf(suggestion.agentId)}
              busy={act.isPending && act.variables?.id === suggestion.id}
              error={
                act.error && act.variables?.id === suggestion.id
                  ? act.error.message
                  : null
              }
              onAnswer={(action) =>
                act.mutate(
                  { id: suggestion.id, action },
                  {
                    onSuccess: (task) => {
                      if (task)
                        void router?.navigate({
                          to: "/tasks/$taskId",
                          params: { taskId: task.id },
                        });
                    },
                  },
                )
              }
              suggestion={suggestion}
            />
          </li>
        ))}
      </ul>
    </TaskSection>
  );
}

function UpNextRow({
  suggestion,
  bot,
  busy,
  error,
  onAnswer,
}: {
  suggestion: ProactiveSuggestion;
  bot: AgentProfile | undefined;
  busy: boolean;
  error: string | null;
  onAnswer: (action: "start" | "dismiss") => void;
}) {
  const from = [
    bot?.name ?? "Your Bot",
    suggestion.sourceApp || suggestion.sourceLink
      ? `From ${suggestion.sourceApp ?? "a connected app"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Item className="px-3 py-3" size="sm">
      <ItemMedia>
        <AbstractAvatar
          name={bot?.name ?? "Your Bot"}
          seed={bot?.avatarSeed ?? suggestion.agentId}
          size={32}
        />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="type-sub line-clamp-2 font-medium">
          {suggestion.title}
        </ItemTitle>
        {suggestion.detail ? (
          <ItemDescription className="type-caption">
            {suggestion.detail}
          </ItemDescription>
        ) : null}
        <ItemDescription className="type-caption line-clamp-1">
          {from}
        </ItemDescription>
      </ItemContent>
      <ItemFooter className="justify-start gap-2 pl-11">
        <Button
          aria-label={`Start ${suggestion.title}`}
          disabled={busy}
          onClick={() => onAnswer("start")}
          size="sm"
        >
          Start
        </Button>
        <Button
          aria-label={`Dismiss ${suggestion.title}`}
          disabled={busy}
          onClick={() => onAnswer("dismiss")}
          size="sm"
          variant="outline"
        >
          Dismiss
        </Button>
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </ItemFooter>
    </Item>
  );
}
