/**
 * The conversations API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads and writes conversations, their messages, members, attachments, voice sessions and
 * tasks through the client generated from api/openapi/conversations.yaml, under
 * `/api/v2/organizations/default`. A list comes back as `{ conversations, nextCursor }`, one
 * conversation as `{ conversation }`, and the API calls a conversation's Bots `botIds`. A refusal is
 * a problem document (RFC 9457) whose `detail` is the sentence a person reads.
 *
 * The sockets (`/api/channels/events`), a conversation's model (`/api/channels/{id}/model`) and the
 * stored form of a sent attachment (`/api/attachments/{id}`) are not part of this and stay where
 * they are.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

/** The one organization's address in the API: every operation here is under it. */
export const ORGANIZATION_PATH = "/api/v2/organizations/default";

/** Where the app lists, searches and starts conversations. */
export const CONVERSATIONS_PATH = `${ORGANIZATION_PATH}/conversations`;

/** Where the app asks which Bot a message should go to. */
export const ROUTE_PATH = `${CONVERSATIONS_PATH}/route`;

/** Where the app lists the person's tasks. */
export const TASKS_PATH = `${ORGANIZATION_PATH}/tasks`;

/** One conversation's address, or one of its sub-resources, as the generated client writes it. */
export function conversationPath(conversationId: string, rest = ""): string {
  return `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}${rest}`;
}

/** One task's address, or one of its actions, as the generated client writes it. */
export function taskPath(taskId: string, rest = ""): string {
  return `${TASKS_PATH}/${encodeURIComponent(taskId)}${rest}`;
}

/** Where the browser loads an attachment's bytes from, and where it deletes one. */
export function attachmentPath(attachmentId: string): string {
  return `${ORGANIZATION_PATH}/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * A conversation in the API's names, from one written in the names the app's screens use: the API
 * calls a conversation's Bots `botIds` and the Bot behind its last message `lastMessageBotId`.
 */
export function conversationOf<
  T extends { agentIds: readonly string[]; lastMessageAgentId?: string | null },
>(
  channel: T,
): Omit<T, "agentIds" | "lastMessageAgentId"> & {
  botIds: string[];
  lastMessageBotId?: string | null;
} {
  const { agentIds, lastMessageAgentId, ...rest } = channel;
  return {
    ...rest,
    botIds: [...agentIds],
    ...(lastMessageAgentId === undefined
      ? {}
      : { lastMessageBotId: lastMessageAgentId }),
  };
}

/** One page of the conversation list, ending the list unless a cursor is given. */
export function conversationPage(
  channels: readonly {
    agentIds: readonly string[];
    lastMessageAgentId?: string | null;
  }[],
  nextCursor: string | null = null,
) {
  return { conversations: channels.map(conversationOf), nextCursor };
}

/**
 * A task in the API's names, from one written in the names the app's screens use: the API calls a
 * task's Bot `botId` and its conversations `conversationId` and `originConversationId`.
 */
export function taskOf<
  T extends {
    agentId: string;
    channelId: string;
    originChannelId?: string | null;
  },
>(task: T) {
  const { agentId, channelId, originChannelId, ...rest } = task;
  return {
    ...rest,
    botId: agentId,
    conversationId: channelId,
    originConversationId: originChannelId ?? null,
  };
}

const TITLES: Record<number, [title: string, category: string, code: string]> =
  {
    400: ["Invalid request.", "validation", "VALIDATION_FAILED"],
    401: ["Sign in.", "auth", "UNAUTHENTICATED"],
    403: ["Not allowed.", "permission", "FORBIDDEN"],
    404: ["Not found.", "not_found", "NOT_FOUND"],
    409: ["Conflict.", "conflict", "CONFLICT"],
    413: ["Too large.", "validation", "PAYLOAD_TOO_LARGE"],
    415: ["Unsupported file.", "validation", "UNSUPPORTED_MEDIA_TYPE"],
    429: ["Too many requests.", "rate_limit", "RATE_LIMITED"],
    500: ["Something went wrong.", "internal", "INTERNAL"],
    502: ["Couldn't reach a service.", "dependency", "DEPENDENCY_FAILED"],
    503: ["Unavailable.", "dependency", "UNAVAILABLE"],
  };

/** The body of a refusal: a problem document, with `detail` as the sentence and `code` its name. */
export function problemBody(status: number, detail: string, code?: string) {
  const [title, category, fallbackCode] = TITLES[status] ?? [
    "Something went wrong.",
    "internal",
    "INTERNAL",
  ];
  return {
    type: `https://open.bot/errors/${category.replace("_", "-")}`,
    title,
    status,
    detail,
    code: code ?? fallbackCode,
    category,
    retryable: status >= 500 || status === 429,
    requestId: "req_test",
    traceId: "trace_test",
  };
}

/** A refusal as the API answers it: `application/problem+json` with the status it names. */
export function problem(
  status: number,
  detail: string,
  code?: string,
): Response {
  return new NativeResponse(JSON.stringify(problemBody(status, detail, code)), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** A write that answers with no content. */
export function noContent(): Response {
  return new NativeResponse(null, { status: 204 });
}

/** A group conversation in the names the app's screens use, as a test writes one. */
export type GroupFixture = {
  bots: readonly { id: string; name: string }[];
  people: readonly {
    userId: string;
    email: string;
    name: string | null;
    creator: boolean;
  }[];
  /** Oldest first, as the transcript reads. */
  messages: readonly {
    id: string;
    ownerUserId: string;
    agentId: string | null;
    text: string;
    status: string;
    createdAt: string;
    reason?: string;
    answeredBy?: string;
    consent?: { botId: string; serverId: string };
    [other: string]: unknown;
  }[];
};

/** A group's members as the API lists them: its Bots and its people in one list, by `kind`. */
export function membersOf(group: Pick<GroupFixture, "bots" | "people">) {
  return [
    ...group.bots.map((bot) => ({ kind: "bot", id: bot.id, name: bot.name })),
    ...group.people.map((person) => ({
      kind: "person",
      id: person.userId,
      name: person.name,
      email: person.email,
      creator: person.creator,
    })),
  ];
}

/** A group's lines as the API lists them: newest first, a person's as `personId`, a Bot's as `botId`. */
export function messagesOf(group: Pick<GroupFixture, "messages">) {
  return group.messages
    .map((message) => ({
      id: message.id,
      role: message.agentId === null ? "person" : "bot",
      personId: message.ownerUserId || null,
      botId: message.agentId,
      text: message.text,
      status: message.status,
      createdAt: message.createdAt,
      ...(message.reason === undefined ? {} : { reason: message.reason }),
      ...(message.answeredBy === undefined
        ? {}
        : { answeredBy: message.answeredBy }),
      ...(message.consent === undefined ? {} : { consent: message.consent }),
    }))
    .reverse();
}

/**
 * The server's answer to either of the two reads a group conversation is drawn from, or undefined
 * for any other request: its members (`GET /conversations/{id}/members`) and its lines
 * (`GET /conversations/{id}/messages`, newest first, at most `limit` of them).
 */
export function answerGroupRead(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  conversationId: string,
  group: GroupFixture,
): Response | undefined {
  const url = new URL(String(input), "http://openbot.invalid");
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  if (url.pathname === conversationPath(conversationId, "/members"))
    return NativeResponse.json({ members: membersOf(group), nextCursor: null });
  if (url.pathname === conversationPath(conversationId, "/messages")) {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    return NativeResponse.json({
      messages: messagesOf(group).slice(0, limit),
      nextCursor: null,
    });
  }
  return undefined;
}
