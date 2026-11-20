import { IconHandStop } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  ASK_FIRST_DESCRIPTION,
  ASK_FIRST_TITLE,
} from "@/components/approvals/ask-first-copy";
import { Switch } from "@/components/ui/switch";
import {
  approvalInboxOptions,
  approvalPreferencesMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";

/**
 * The approval step's one setting, offered on the step rather than described: Extra vigilant, the
 * same switch and the same preference as Settings → Approvals, in the same words
 * (ask-first-copy.ts). It takes effect when switched, and a change that fails is said under it.
 *
 * The step is still a picture of what a Bot asks; the switch sits with the words, outside the
 * picture's frame, because it is the one real control here.
 */
export function AskFirstSwitch() {
  // Read once: the inbox's own polling is for the approvals page, not for a single switch.
  const inbox = useQuery({ ...approvalInboxOptions(), refetchInterval: false });
  const preferences = useMutation(
    approvalPreferencesMutationOptions(queryClient),
  );
  // While a change is on its way, the switch shows it rather than snapping back until it lands.
  const checked = preferences.isPending
    ? preferences.variables.enabled === true
    : (inbox.data?.enabled ?? false);
  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <Item size="sm" variant="outline">
        <ItemMedia variant="icon">
          <IconHandStop />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{ASK_FIRST_TITLE}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {ASK_FIRST_DESCRIPTION}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label={ASK_FIRST_TITLE}
            checked={checked}
            disabled={inbox.isPending || preferences.isPending}
            onCheckedChange={(enabled) => preferences.mutate({ enabled })}
          />
        </ItemActions>
      </Item>
      {preferences.error ? (
        <p className="text-sm text-destructive" role="alert">
          Couldn't change it. Try again, or change it later in Settings.
        </p>
      ) : inbox.error ? (
        <p className="text-sm text-muted-foreground" role="status">
          Couldn't load this setting. You can change it later in Settings.
        </p>
      ) : null}
    </div>
  );
}
