import type { Message } from "@ag-ui/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  canSend,
  type Recipient,
  startsGroup,
  toFieldChange,
} from "@/components/channels/compose-state";
import {
  type ComposerDraft,
  toAgentOptions,
} from "@/components/channels/composer";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
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
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useBotTakesModelChoice } from "@/lib/bot-agents/queries";
import { fallbackBot, useStartChannel } from "@/lib/channels/start";
import { useAttachmentLimits } from "@/lib/deployment/queries";
import {
  type Failure,
  failureOf,
  failureSaid,
  loadFailure,
} from "@/lib/load-failure";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { useDraftModel } from "@/lib/models/run-model";
import {
  useAnyBotSkillCommands,
  useSkillCommands,
} from "@/lib/plugins/skill-commands";
import { searchTextEntry } from "@/lib/search-text";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the conversation on first send. One Bot in the To: field is an ordinary channel; two or
 * more are a group, answering in the order they were picked. The first Bot stays in the URL so
 * profile links and reloads preserve the pending recipient without creating an empty channel.
 */
/** What the API's `getBot` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Couldn't find that Bot.";

/** Said when a draft holding files is sent to two or more Bots. */
const GROUP_TAKES_NO_FILES =
  "A conversation with more than one Bot can't take files yet. Remove them to send.";

export const Route = createFileRoute("/_authed/_app/channel/new")({
  /*
   * The pending recipient's id, read as text whatever the router parsed it into (`searchText`):
   * search values are JSON-parsed, so a Bot id made of digits would otherwise arrive as a number
   * and the link would open an empty composer instead of the one it names.
   */
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    searchTextEntry("agent", search.agent),
  /*
   * Which new conversation this is. Every arrival here that this page did not make itself is a
   * fresh one: the + button (pressed once or many times), a Bot's profile link, Back to an earlier
   * draft. Each is given its own id here, in history state. The page's own navigations (a Bot
   * picked or removed, a Bot made from the picker) carry the id forward, so they keep the draft
   * they belong to.
   *
   * WHY NOT JUST THE URL: the picked Bots and the typed message live in this page, not the URL, and
   * a second visit to the same route does not remount it. Pressing + while a Bot was already picked
   * dropped `?agent=` from the URL but left the Bot in To: and the message in the box, so the screen
   * and the URL disagreed and a reload changed who the message would go to.
   *
   * WHY NOT THE HISTORY ENTRY'S OWN KEY: the router makes no history entry for a navigation to the
   * location it is already on. A second press of + on an untouched new conversation was exactly
   * that, so nothing remounted, and the first press had already closed the To: picker as a click
   * outside it and left focus on +. An arrival without an id is now always a different location
   * from one with an id, so every press is a new entry and a fresh page.
   *
   * WHY CONTEXT AND NOT THE LOCATION: the router publishes a new location before the route's search
   * catches up, so a page keyed on the location remounted once with the new key and the old
   * `?agent=`, and handed the caret to the composer. Context commits with the search.
   */
  beforeLoad: ({ location }) => {
    const composition = location.state.newConversation;
    if (!composition) {
      throw redirect({
        replace: true,
        search: location.search,
        state: ownedBy(newId()),
        to: "/channel/new",
      });
    }
    return { composition };
  },
  component: RouteComponent,
});

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set by `/channel/new` on its own navigations: which new conversation they belong to. */
    newConversation?: string;
  }
}

/** History state marking a navigation as this page's own. */
function ownedBy(composition: string) {
  return { newConversation: composition };
}

function RouteComponent() {
  const { composition } = Route.useRouteContext();
  return <NewConversation composition={composition} key={composition} />;
}

function NewConversation({ composition }: { composition: string }) {
  const { agent } = Route.useSearch();
  const queryClient = useQueryClient();
  const [creatingBot, setCreatingBot] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const navigate = Route.useNavigate();
  const { startChosen, startGroup, startPicked, pending } = useStartChannel();
  const {
    data: profiles,
    isError: rosterError,
    error: rosterFailure,
  } = useQuery(agentListQueryOptions());
  /** Who OpenBot can send to when nobody is in To:. Undefined only when the person has no Bot. */
  const fallback = fallbackBot(profiles);
  const [error, setError] = useState<Failure | null>(null);
  /** Enter or Send was pressed with no Bot to send to at all. Said until a Bot is chosen. */
  const [askedForBot, setAskedForBot] = useState(false);
  const pickerInput = useRef<HTMLInputElement>(null);
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
  /*
   * The URL names a recipient up front (a Bot's own Message link). Without one, To: starts empty
   * and closed, and the caret is in the message, as on home: OpenBot picks the Bot when the
   * message is sent (`startPicked`, home's own path), and To: is there for choosing one or more
   * yourself. Asking who every conversation was for, with the menu open, was a question most
   * people did not need to answer.
   *
   * Nobody is put in To: on the person's behalf. A Bot picked for them there was one they had to
   * notice and remove; To: says instead that OpenBot picks.
   *
   * FOUND ON WINDOWS: a message typed with nobody in To: once went nowhere. It now goes to the Bot
   * OpenBot picks, and a failed start keeps it in the box with the reason. With no Bot at all to
   * pick, Send keeps the message, says "Choose a Bot first." and opens To:, which offers New Bot.
   */
  const chosen = listed ?? (fetched?.id === agent ? fetched : undefined);
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? loadFailure(
          rosterFailure,
          "Couldn't load your Bots. Try again in a moment.",
        )
      : urlAgentDetailFailed
        ? /*
           * The server's 404 sentence (agents/routes.ts `mapStoreError`) means this person cannot see
           * the Bot: a shared Team Bot link lands here once it is unpublished or undescribed. Any
           * other failure is a load that can be retried, and says so.
           */
          detailFailure?.message === AGENT_NOT_FOUND
          ? "This Bot isn't available to you. It may be unpublished or not shared with you."
          : loadFailure(
              detailFailure,
              "Couldn't load that Bot. Try again in a moment.",
            )
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
  /*
   * A model can be picked before the first message when the conversation is with one Bot that runs
   * on OpenBot's own model. The pick is saved with the conversation, before the message runs.
   */
  const takesModel = useBotTakesModelChoice(
    !group && selected.length === 1 ? selected[0] : undefined,
  );
  // Not a Bot that hands work out: it answers on its own model.
  const pickable = !group && selected.length === 1 && takesModel;
  const models = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: pickable,
  });
  const draftModel = useDraftModel(
    pickable ? models.data : undefined,
    pickable ? selected[0]?.defaultModel : undefined,
  );
  // A group's first message goes to all of its Bots, so no one Bot's commands are offered.
  const skillCommands = useSkillCommands(
    group ? "" : (recipients[0]?.id ?? ""),
  );
  /*
   * Nobody in To: is home's composer: `/` offers every skill any Bot has, and sending picks a Bot
   * that has the one used.
   */
  const { commands: anyBotCommands } = useAnyBotSkillCommands(
    recipients.length === 0
      ? (profiles?.map((profile) => profile.id) ?? [])
      : [],
  );
  const attachmentLimits = useAttachmentLimits();

  /** Nobody in To:: OpenBot picks the Bot, or the one named with `@`, exactly as home does. */
  const submitToPicked = async (draft: ComposerDraft) => {
    if (!draft.text.trim() && draft.attachments.length === 0) return;
    setError(null);
    setSent(seedMessage(draft.text, newId()));
    try {
      if (draft.agentId)
        await startChosen(
          draft.agentId,
          draft.text,
          null,
          undefined,
          draft.attachments,
        );
      else
        await startPicked({
          text: draft.text,
          skills: draft.commandIds,
          roster: profiles,
          files: draft.attachments,
        });
    } catch (caught) {
      // The words stay in the box, with the reason under them.
      setSent(null);
      setError(
        failureOf(caught, "Couldn't start the conversation. Try again."),
      );
      throw caught;
    }
  };

  const submit = async (draft: ComposerDraft) => {
    const recipient = recipients[0];
    if (!recipient) {
      if (fallback) await submitToPicked(draft);
      return;
    }
    if (!canSend(recipients, draft.text, draft.attachments.length)) return;
    if (group) {
      // A group's messages carry words only, in this first message as in every later one. Files
      // held before a second Bot was added are refused out loud and stay on the strip.
      if (draft.attachments.length > 0) {
        setError({ message: GROUP_TAKES_NO_FILES });
        throw new Error(GROUP_TAKES_NO_FILES);
      }
      setError(null);
      try {
        // An `@` addresses one Bot, as it does in every later message of the group.
        await startGroup(
          recipients.map((entry) => entry.id),
          draft.text,
          draft.agentId,
        );
      } catch (caught) {
        setError(failureOf(caught, "Couldn't start the group. Try again."));
        throw caught;
      }
      return;
    }

    setError(null);
    setSent(seedMessage(draft.text, newId()));

    try {
      // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
      // home screen, and the trail has to say so for both.
      // A `/` skill stays at the start of the words, where the server finds it, as it does for
      // every later message.
      await startChosen(
        recipient.id,
        draft.text,
        draftModel.requested,
        undefined,
        draft.attachments,
      );
    } catch (caught) {
      // Preserve the unsent draft when channel creation fails.
      setSent(null);
      setError(
        failureOf(caught, "Couldn't start the conversation. Try again."),
      );
      throw caught;
    }
  };

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div
        className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center"
        data-slot="conversation-header"
      >
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>
        <Combobox
          // Never opens by itself: OpenBot picks unless the person opens it to choose.
          open={pickerOpen}
          onOpenChange={setPickerOpen}
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
            setAskedForBot(false);
            // The first Bot stays in the URL so a reload keeps the conversation's recipient; the
            // rest of a group lives in the page. Not a separate navigation history entry.
            void navigate({
              replace: true,
              search: kept[0] ? { agent: kept[0].id } : {},
              state: ownedBy(composition),
            });
          }}
          value={selected}
        >
          <ComboboxChips
            ref={anchor}
            className="flex-1 border-none bg-transparent! focus-within:ring-0"
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
              ref={pickerInput}
              // Home's hint, said where the choice is made: nobody here means OpenBot picks.
              placeholder={
                selected.length
                  ? "Add another Bot for a group…"
                  : fallback
                    ? "OpenBot picks the right Bot, or choose one…"
                    : "Choose a Bot…"
              }
            />
          </ComboboxChips>
          {/* Allow max-w to constrain the popup even though its anchor is full-width. */}
          <ComboboxContent
            anchor={anchor}
            className="flex min-w-0 max-w-lg flex-col"
            sideOffset={12}
          >
            <div className="shrink-0 border-b p-1">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setPickerOpen(false);
                  setCreatingBot(true);
                }}
              >
                <AgentOrb size="24px" state="idle" />
                <span className="font-medium">New Bot</span>
                <span className="text-muted-foreground">Create a new Bot</span>
              </button>
            </div>
            <ComboboxEmpty>No Bots found.</ComboboxEmpty>
            <ComboboxList className="min-h-0">
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
      <NewBotSheet
        open={creatingBot}
        onClose={() => setCreatingBot(false)}
        onCreated={(agentId) => {
          setCreatingBot(false);
          void queryClient
            .fetchQuery(agentQueryOptions(agentId))
            .then((profile) => {
              setPicked((current) => {
                const existing = current ?? selected;
                return existing.some((bot) => bot.id === profile.id)
                  ? existing
                  : [...existing, profile];
              });
              if (selected.length === 0)
                void navigate({
                  replace: true,
                  search: { agent: agentId },
                  state: ownedBy(composition),
                });
            })
            .catch(() => {
              setError({
                message:
                  "Your Bot was created, but could not be selected. Choose it from the recipient list.",
              });
            });
        }}
      />
      <ConversationView
        /*
         * `@` offers the Bots in To:. The conversation does not exist until the first message is
         * sent, so the people it is with are the ones picked here, and a first message can address
         * one of them as every later one can.
         */
        agents={toAgentOptions(selected.length ? selected : profiles)}
        // The message is what the page is for, so the caret starts in it, with or without a Bot
        // in To:. A Bot the URL names is waited for first (the composer is disabled until then).
        autoFocus
        // Commands must be loaded before the first channel message is sent.
        commands={recipients.length ? skillCommands : anyBotCommands}
        /*
         * Files are held until the first message creates the conversation, then sent with it. Not
         * for a group: its messages carry words only, so its composer offers no `+`.
         */
        holdsFilesUntilSent={!group}
        attachmentLimits={attachmentLimits}
        modelPicker={
          <ModelPicker
            catalogue={pickable ? models.data : undefined}
            defaultModel={draftModel.defaultModel}
            onChange={draftModel.choose}
            value={draftModel.value}
          />
        }
        disabled={Boolean(loadError) || waitingForUrlAgent}
        /*
         * NO BOT AT ALL: SENDING WAITS FOR ONE. The composer used to be disabled until To: had
         * somebody in it, and a disabled composer is a dead end: it took a paste but no typing, no
         * caret, and an Enter that went nowhere with nothing said. It takes words as home's does.
         * With a Bot for OpenBot to pick, Enter sends; with none, Enter opens To: (where New Bot is)
         * and says why. The words stay put, and the caret comes back to them once a Bot is picked.
         */
        {...(recipients.length === 0 && !fallback
          ? {
              onSendHeld: () => {
                setAskedForBot(true);
                setPickerOpen(true);
                pickerInput.current?.focus();
              },
            }
          : {})}
        messages={sent ? [sent] : []}
        starterSuggestions={
          !group && !sent ? (
            <StarterSuggestions
              bot={selected[0]}
              disabled={pending || Boolean(loadError) || waitingForUrlAgent}
              onSelect={(text) =>
                submit({
                  text,
                  commandIds: [],
                  attachments: [],
                  agentId: recipients[0]?.id ?? null,
                  isEmpty: false,
                })
              }
            />
          ) : undefined
        }
        notice={
          loadError || error ? (
            <p className="px-3.5 pb-2 text-sm text-destructive" role="alert">
              {loadError ?? failureSaid(error)}
            </p>
          ) : askedForBot && recipients.length === 0 ? (
            <p
              className="px-3.5 pb-2 text-sm text-muted-foreground"
              role="status"
            >
              Choose a Bot first.
            </p>
          ) : null
        }
        onSubmit={submit}
        pending={pending}
      />
    </div>
  );
}
