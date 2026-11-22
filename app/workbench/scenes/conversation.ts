/*
 * A conversation that a person opens while its Bot is still in the middle of a run.
 *
 * The channel page (app/src/routes/_authed/_app/channel/$channelId.tsx) reads the conversation, and
 * ChannelChat (app/src/components/channels/channel-chat.tsx) joins the thread through the runtime's
 * connect request (app/src/lib/copilot/join-thread.ts). The run's AG-UI events come down that join:
 * the stream registry (../api/agentStream.ts) keeps the events that a step pushes before the page
 * connects, and writes them when it connects. ChannelChat reads the thread's stored messages
 * (app/src/lib/copilot/thread-messages.ts) only after the join is over, and this join stays open
 * for the whole scene. So the person's question comes in the replay, in RUN_STARTED's
 * `input.messages`, which @ag-ui/client adds to the conversation.
 *
 * The two tools are app tools (`mcp__<server>__<tool>`), so each step line names its action in
 * words, as shared/tool-name.ts reads it: "List tasks" on Tasks, "List events" on Calendar. Pattern:
 * the replayed turn in app/tests/ask-person-replay.fixture.ts.
 */
import {
  EventType,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import type {
  AppScene,
  AppSceneStart,
} from "../../../desktop/workbench/appContract";
import type {
  ConversationPage,
  ConversationResponse,
  ConversationSummary,
  VoiceSessionPage,
} from "../../src/lib/api/generated/model";
import { DEFAULT_SESSION } from "../session";

/** A Bot of the generated Bots list, so the runtime's info lists it. */
const BOT = "general-assistant";
const CONVERSATION = "conversation-plate-today";
const THREAD = "thread-plate-today";
const RUN = "run-plate-today";

const ASKED = "What is on my plate today?";
const OPENING = "message-opening";
const REPLY = "message-reply";

const TASKS_CALL = "call-list-tasks";
const TASKS_TOOL = "mcp__tasks__list_tasks";
const EVENTS_CALL = "call-list-events";
const EVENTS_TOOL = "mcp__calendar__list_events";

/** The calendar call's arguments, sent in two pieces so the line shows the call while it streams. */
const EVENTS_ARGS =
  '{"calendar": "work", "from": "2026-11-23T00:00:00Z", "to": "2026-11-24T00:00:00Z"}';
const EVENTS_ARGS_SPLIT = EVENTS_ARGS.indexOf('"from"');

const ids = { threadId: THREAD, runId: RUN };

const ASKED_MESSAGE = {
  id: "message-asked",
  role: "user",
  content: ASKED,
} as const;

/** The conversation as the sidebar lists it. `busy`: its Bot is answering in it now. */
const LISTED = {
  id: CONVERSATION,
  name: "Plan for today",
  botIds: [BOT],
  threadId: THREAD,
  active: true,
  lastMessageAt: "2026-11-23T08:00:00.000Z",
  summary: null,
  opening: ASKED,
  lastMessage: null,
  lastMessageBotId: null,
  createdAt: "2026-11-23T08:00:00.000Z",
  pinned: false,
  lastReadAt: "2026-11-23T08:00:00.000Z",
  canRename: true,
  task: false,
  work: [],
  busy: true,
} satisfies ConversationSummary;

const start: AppSceneStart = {
  route: `/channel/${CONVERSATION}`,
  host: "desktop",
  session: DEFAULT_SESSION,
  agents: [BOT],
  api: {
    // channelListQueryOptions in app/src/lib/channels/queries.ts: the sidebar lists this conversation.
    "GET /api/v2/organizations/:organizationId/conversations": {
      mode: "value",
      body: {
        conversations: [LISTED],
        nextCursor: null,
      } satisfies ConversationPage,
    },
    // channelQueryOptions in app/src/lib/channels/queries.ts: one Bot, so it is a chat, not a group.
    "GET /api/v2/organizations/:organizationId/conversations/conversation-plate-today":
      {
        mode: "value",
        body: {
          conversation: {
            id: LISTED.id,
            name: LISTED.name,
            botIds: LISTED.botIds,
            threadId: LISTED.threadId,
            active: LISTED.active,
            lastMessageAt: LISTED.lastMessageAt,
            work: [],
          },
        } satisfies ConversationResponse,
      },
    // The conversation's voice chats: none. The generated answer has one, which is not this story.
    "GET /api/v2/organizations/:organizationId/conversations/conversation-plate-today/voice-sessions":
      {
        mode: "value",
        body: { sessions: [], nextCursor: null } satisfies VoiceSessionPage,
      },
    // readThreadMessages in app/src/lib/copilot/thread-messages.ts: what the store holds, for a read
    // after the join (a seek past a reload, or the panel ending the stream).
    "GET /api/copilotkit/threads/thread-plate-today/messages": {
      mode: "value",
      body: { messages: [ASKED_MESSAGE] },
    },
  },
};

export const CONVERSATION_SCENES: readonly AppScene[] = [
  {
    kind: "app",
    id: "app-conversation-tools",
    title: "A conversation in the middle of a run",
    group: "App: Conversation",
    start,
    // The run as the runtime streams it to the join: the Bot says what it does, its tasks call ends,
    // its calendar call streams its arguments in two pieces and then ends, and a reply starts. No
    // RUN_FINISHED: the run is still going at the end.
    run: [
      {
        at: 0,
        stream: BOT,
        events: [
          {
            type: EventType.RUN_STARTED,
            ...ids,
            // The person's turn that started this run, as the runtime replays it to a join.
            input: {
              ...ids,
              messages: [ASKED_MESSAGE],
              tools: [],
              context: [],
              state: {},
              forwardedProps: {},
            },
          } satisfies RunStartedEvent,
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: OPENING,
            role: "assistant",
          } satisfies TextMessageStartEvent,
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: OPENING,
            delta: "I'll look at your tasks and your calendar.",
          } satisfies TextMessageContentEvent,
          {
            type: EventType.TEXT_MESSAGE_END,
            messageId: OPENING,
          } satisfies TextMessageEndEvent,
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: TASKS_CALL,
            toolCallName: TASKS_TOOL,
            parentMessageId: OPENING,
          } satisfies ToolCallStartEvent,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: TASKS_CALL,
            delta: '{"due": "today"}',
          } satisfies ToolCallArgsEvent,
          {
            type: EventType.TOOL_CALL_END,
            toolCallId: TASKS_CALL,
          } satisfies ToolCallEndEvent,
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${TASKS_CALL}-result`,
            role: "tool",
            toolCallId: TASKS_CALL,
            content:
              "3 tasks due today: send the budget draft, review the hiring plan, book the team lunch.",
          } satisfies ToolCallResultEvent,
        ],
      },
      {
        at: 2,
        stream: BOT,
        events: [
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: EVENTS_CALL,
            toolCallName: EVENTS_TOOL,
            parentMessageId: OPENING,
          } satisfies ToolCallStartEvent,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: EVENTS_CALL,
            delta: EVENTS_ARGS.slice(0, EVENTS_ARGS_SPLIT),
          } satisfies ToolCallArgsEvent,
        ],
      },
      {
        at: 4,
        stream: BOT,
        events: [
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: EVENTS_CALL,
            delta: EVENTS_ARGS.slice(EVENTS_ARGS_SPLIT),
          } satisfies ToolCallArgsEvent,
        ],
      },
      {
        at: 6,
        stream: BOT,
        events: [
          {
            type: EventType.TOOL_CALL_END,
            toolCallId: EVENTS_CALL,
          } satisfies ToolCallEndEvent,
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${EVENTS_CALL}-result`,
            role: "tool",
            toolCallId: EVENTS_CALL,
            content:
              "2 events today: 10:00 team stand-up, 14:00 call with the design agency.",
          } satisfies ToolCallResultEvent,
        ],
      },
      {
        at: 7,
        stream: BOT,
        events: [
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: REPLY,
            role: "assistant",
          } satisfies TextMessageStartEvent,
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: REPLY,
            delta: "You have three tasks and two meetings today. First, ",
          } satisfies TextMessageContentEvent,
        ],
      },
    ],
  },
];
