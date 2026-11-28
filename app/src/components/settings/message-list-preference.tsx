import { IconLayoutList, IconLayoutSidebar } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
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
import { useConversationView } from "@/lib/settings/conversation-view";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { failureSaid } from "@/lib/load-failure";

export function MessageListPreference() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;
  const [view, setView] = useConversationView();

  return (
    <PageRows>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconLayoutList />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Conversation list</ItemTitle>
          <ItemDescription>
            Show each conversation on one line, or with its Bot's name above the
            title. This browser remembers your choice.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={view}
            onValueChange={(value) =>
              setView(value === "detailed" ? "detailed" : "compact")
            }
          >
            <SelectTrigger aria-label="Conversation list">
              <SelectValue>
                {view === "detailed" ? "Detailed" : "Compact"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="detailed">Detailed</SelectItem>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {/* Which of the two lines stands out: a compact row has one, so only Detailed asks. */}
      {view === "detailed" ? <Separator /> : null}
      {view === "detailed" ? (
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconLayoutSidebar />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Message list emphasis</ItemTitle>
            <ItemDescription>
              Choose which line stands out in the sidebar.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select
              value={emphasis ?? null}
              disabled={!preferences.data || save.isPending}
              onValueChange={(value) => {
                if (value === "agent" || value === "thread") {
                  save.mutate({ messageListEmphasis: value });
                }
              }}
            >
              <SelectTrigger aria-label="Message list emphasis">
                <SelectValue>
                  {emphasis
                    ? emphasis === "agent"
                      ? "Bot name"
                      : "Conversation title"
                    : "Loading…"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thread">Conversation title</SelectItem>
                <SelectItem value="agent">Bot name</SelectItem>
              </SelectContent>
            </Select>
          </ItemActions>
        </Item>
      ) : null}
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {failureSaid(preferences.error)}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {failureSaid(save.error)}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          Saving…
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 pt-3 pb-6">
          <figure
            aria-label="Message list preview"
            className="flex h-16 w-full max-w-xs items-center rounded-lg border border-border bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name="General Assistant"
              title="Plan next week"
              lastMessageAt="2h"
              emphasis={emphasis}
              view={view}
            />
          </figure>
        </div>
      ) : null}
    </PageRows>
  );
}
