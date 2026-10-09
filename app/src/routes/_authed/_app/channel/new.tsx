import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  canSend,
  type Recipient,
  startsGroup,
  toFieldChange,
} from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the conversation on first send. One Bot in the To: field is an ordinary channel; two or
 * more are a group, answering in the order they were picked. The first Bot stays in the URL so
 * profile links and reloads preserve the pending recipient without creating an empty channel.
 */
/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Agent not found.";

export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { startChosen, startGroup, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    error: detailFailure,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const chosen =
    listed ??
    (fetched?.id === agent ? fetched : undefined) ??
    (agent ? undefined : defaultAgentProfile(profiles));
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? "Coworkers couldn't be loaded."
      : urlAgentDetailFailed
        ? /*
           * The server's 404 sentence (agents/routes.ts `mapStoreError`) means this person cannot see
           * the Bot: a shared Team Bot link lands here once it is unpublished or undescribed. Any
           * other failure is a load that can be retried, and says so.
           */
          detailFailure?.message === AGENT_NOT_FOUND
          ? "This Bot isn't available to you. It may be unpublished, not shared with you, or not described yet."
          : "Coworker couldn't be loaded."
        : null;
  /** Bots picked in the To: field, in the order they will answer; the URL's Bot until one is picked. */
  const [picked, setPicked] = useState<AgentProfile[] | null>(null);
  const selected = picked ?? (chosen ? [chosen] : []);
  const anchor = useComboboxAnchor();
  const recipients: Recipient[] = selected.map((profile) => ({
    id: profile.id,
    name: profile.name,
  }));
  const group = startsGroup(recipients);
  // A group's first message goes to all of its Bots, so no one Bot's commands are offered.
  const skillCommands = useSkillCommands(
    group ? "" : (recipients[0]?.id ?? ""),
  );

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>
        <Combobox
          // Do not auto-open when the recipient came from the URL; the field is already answered.
          defaultOpen={!chosen && !loadError && !waitingForUrlAgent}
          autoHighlight
          multiple
          items={profiles ?? []}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next: AgentProfile[], details) => {
            const kept = toFieldChange(selected, next, details.reason);
            setPicked(kept);
            // The first Bot stays in the URL so a reload keeps the conversation's recipient; the
            // rest of a group lives in the page. Not a separate navigation history entry.
            void navigate({
              replace: true,
              search: kept[0] ? { agent: kept[0].id } : {},
            });
          }}
          value={selected}
        >
          <ComboboxChips
            ref={anchor}
            className="flex-1 border-none bg-transparent! focus-within:ring-0 dark:bg-transparent!"
          >
            {selected.map((profile) => (
              <ComboboxChip
                className="gap-1.5 pl-1"
                key={profile.id}
                removeLabel={`Remove ${profile.name}`}
              >
                <ChannelAvatar participantIds={[profile.id]} size={16} />
                {profile.name}
              </ComboboxChip>
            ))}
            <ComboboxChipsInput
              // The popup opening is not enough on its own: typing filters through this input, so
              // the caret starts here whenever the recipient question is still open. A recipient
              // from the URL means the composer takes focus instead.
              autoFocus={!chosen}
              placeholder={
                selected.length
                  ? "Add another Bot for a group…"
                  : "Choose a Bot…"
              }
            />
          </ComboboxChips>
          {/* Allow max-w to constrain the popup even though its anchor is full-width. */}
          <ComboboxContent
            anchor={anchor}
            className="min-w-0 max-w-lg"
            sideOffset={12}
          >
            <ComboboxEmpty>No Bots found.</ComboboxEmpty>
            <ComboboxList>
              {(item: AgentProfile) => (
                <ComboboxItem key={item.id} value={item} className="h-10">
                  <ChannelAvatar participantIds={[item.id]} size={24} />
                  {item.name}
                  <span className="truncate text-muted-foreground ml-1">
                    {item.title}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <ConversationView
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;
          if (group) {
            setError(null);
            try {
              await startGroup(
                recipients.map((entry) => entry.id),
                draft.text,
              );
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not start the group.",
              );
              throw caught;
            }
            return;
          }

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
            // home screen, and the trail has to say so for both.
            await startChosen(recipient.id, draft.text);
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
