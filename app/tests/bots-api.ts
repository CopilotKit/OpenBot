/**
 * The Bots API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reaches Bots and Team Bots through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/...`. A list comes back as a page (`nextCursor` null ends it), one
 * Bot as `{ bot }`, a Bot's handoff, lifecycle and activity as themselves, and a write that answers
 * nothing as 204. Every write carries an `Idempotency-Key`. Paths here are written as the generated
 * client writes them, with the Bot's id encoded as one segment.
 */
import type {
  BotActivity,
  BotAttention,
  BotHandoff,
  BotLifecycle,
  BotResetCounts,
  TeamBot,
} from "@/lib/api/generated/model";

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";

/** Where the app sends the Bots operations: the API's address in the one organization. */
export const BOTS_PATH = `${ORGANIZATION}/bots`;

/** Where a Bot's address is tried before it is saved. */
export const TEST_CONNECTION_PATH = `${BOTS_PATH}/test-connection`;

/** What each Bot has waiting on the signed-in person, a page at a time. */
export const BOT_ATTENTION_PATH = `${ORGANIZATION}/people/me/bot-attention`;

/** The published Bots this person may use or manages. */
export const TEAM_BOTS_PATH = `${ORGANIZATION}/team-bots`;

/** Forgets every answer the signed-in person gave a Team Bot about their own accounts. */
export const CLEAR_TEAM_BOT_CONSENTS_PATH = `${ORGANIZATION}/people/me/clear-team-bot-consents`;

/** One Bot's address in the API, written as the generated client writes it. */
export function botPath(botId: string): string {
  return `${BOTS_PATH}/${encodeURIComponent(botId)}`;
}

/** What can be read or done to one Bot, each at its own address under {@link botPath}. */
export type BotOperation =
  | "duplicate"
  | "hide"
  | "unhide"
  | "pin"
  | "unpin"
  | "issue-callback-token"
  | "revoke-callback-token"
  | "report-decline"
  | "handoff"
  | "lifecycle"
  | "pause"
  | "resume"
  | "reset"
  | "activity"
  | "stop-handoff";

export function botOperationPath(botId: string, operation: BotOperation) {
  return `${botPath(botId)}/${operation}`;
}

/** A Team Bot's address: publishing is a PUT here, unpublishing a DELETE. */
export function teamBotPath(botId: string): string {
  return `${TEAM_BOTS_PATH}/${encodeURIComponent(botId)}`;
}

/** One group a Team Bot is assigned to: PUT assigns it, DELETE takes it away. */
export function teamBotAssignmentPath(botId: string, group: string): string {
  return `${teamBotPath(botId)}/group-assignments/${encodeURIComponent(group)}`;
}

/** Where a person answers a Team Bot asking to use one of their accounts. */
export function teamBotConsentPath(botId: string): string {
  return `${teamBotPath(botId)}/answer-consent`;
}

/** One request as the app sent it, for a test to assert on. */
export type SentRequest = {
  method: string;
  /** The address and query, as the generated client wrote them. */
  path: string;
  /** The `Idempotency-Key` header, or null when there was none. */
  key: string | null;
  /** The JSON body, parsed, or undefined when there was none. */
  body: unknown;
};

/** Reads what a faked `fetch` was called with. */
export function sentRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): SentRequest {
  const url = new URL(String(input), "http://openbot.invalid");
  const headers = new Headers(init?.headers);
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    path: `${url.pathname}${url.search}`,
    key: headers.get("idempotency-key"),
    body:
      typeof init?.body === "string" && init.body !== ""
        ? JSON.parse(init.body)
        : undefined,
  };
}

/**
 * The server's answer to the app's request for the Bots list, or undefined for any other request.
 *
 * Every Bot on the first page, whatever `limit` asks for, so the answer always ends the list.
 * `hidden=true` lists the Bots hidden from the list instead.
 */
export function answerBotsList(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  bots: { visible: readonly unknown[]; hidden?: readonly unknown[] },
): Response | undefined {
  const url = new URL(String(input), "http://openbot.invalid");
  if (url.pathname !== BOTS_PATH) return undefined;
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  const hidden = url.searchParams.get("hidden") === "true";
  return NativeResponse.json({
    bots: hidden ? (bots.hidden ?? []) : bots.visible,
    nextCursor: null,
  });
}

/** One Bot, as `getBot` and every write that changes a Bot answer it. */
export function botResponse(bot: unknown, status = 200): Response {
  return NativeResponse.json({ bot }, { status });
}

/** A write the API answers with nothing: 204. */
export function noContent(): Response {
  return new NativeResponse(null, { status: 204 });
}

/** A refusal, as the API's problem details carry it. */
export function problemResponse(status: number, detail: string): Response {
  return NativeResponse.json(
    { type: "about:blank", title: "Refused", status, detail },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/** A Bot's new callback token, handed over this once. */
export function callbackTokenResponse(token: string): Response {
  return NativeResponse.json({ token });
}

/** Which Bots a Bot may hand work to: the object itself, not wrapped. */
export function handoffResponse(handoff: Partial<BotHandoff> = {}): Response {
  return NativeResponse.json({
    enabled: true,
    canGrant: false,
    reachable: [],
    grantable: true,
    ...handoff,
  } satisfies BotHandoff);
}

/** The person's own state with a Bot, with what a test left out read as not paused. */
export function lifecycleOf(
  botId: string,
  lifecycle: Partial<BotLifecycle> = {},
): BotLifecycle {
  return {
    botId,
    paused: false,
    pausedAt: null,
    notify: "all",
    ...lifecycle,
  };
}

export function lifecycleResponse(lifecycle: BotLifecycle): Response {
  return NativeResponse.json(lifecycle);
}

/** What pausing answers: the lifecycle it left, and how many running turns it stopped. */
export function pauseResponse(
  lifecycle: BotLifecycle,
  stoppedTurns = 0,
): Response {
  return NativeResponse.json({ lifecycle, stoppedTurns });
}

/** A Bot's activity, with the sections a test left out empty. */
export function activityOf(activity: Partial<BotActivity> = {}): BotActivity {
  return {
    inProgress: [],
    scheduled: [],
    onDemand: [],
    completed: [],
    ...activity,
  };
}

export function activityResponse(
  activity: Partial<BotActivity> = {},
): Response {
  return NativeResponse.json(activityOf(activity));
}

/** What a reset counted or deleted, with the kinds a test left out at nothing. */
export function resetResponse(
  deleted: Partial<BotResetCounts>,
  validateOnly: boolean,
): Response {
  return NativeResponse.json({
    validateOnly,
    deleted: {
      conversations: 0,
      sharedConversationsKept: 0,
      memorySources: 0,
      memories: 0,
      routines: 0,
      responsibilities: 0,
      followUps: 0,
      formedMemories: 0,
      backgroundResearch: 0,
      standingApprovals: 0,
      ...deleted,
    },
  });
}

/** What trying a Bot's address found. A failed test is an answer: ok false, with the reason. */
export function connectionTestResponse(
  verdict: { ok: true; events: string[] } | { ok: false; reason: string },
): Response {
  return NativeResponse.json(
    verdict.ok
      ? { ok: true, events: verdict.events, reason: null }
      : { ok: false, events: [], reason: verdict.reason },
  );
}

/** One Bot's attention, with what a test left out at nothing waiting. */
export function attentionOf(
  botId: string,
  name: string,
  attention: Partial<BotAttention> = {},
): BotAttention {
  return {
    botId,
    name,
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
    items: 0,
    tasks: { needsInput: 0, ready: 0, failed: 0 },
    waitingIn: null,
    ...attention,
  };
}

/**
 * The server's answer to the app's read of what each Bot has waiting on the person, or undefined
 * for any other request. `pageSize` Bots to a page, every page carrying the newest ping, and the
 * cursor naming the next page's first Bot.
 */
export function answerBotAttention(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  attention: {
    bots: readonly BotAttention[];
    lastPingId?: string | null;
    pageSize?: number;
  },
): Response | undefined {
  const url = new URL(String(input), "http://openbot.invalid");
  if (url.pathname !== BOT_ATTENTION_PATH) return undefined;
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  const size = attention.pageSize ?? attention.bots.length;
  const cursor = url.searchParams.get("cursor");
  const start = cursor ? Number(cursor.slice("from".length)) : 0;
  const end = start + Math.max(size, 1);
  return NativeResponse.json({
    attention: attention.bots.slice(start, end),
    lastPingId: attention.lastPingId ?? null,
    nextCursor: end < attention.bots.length ? `from${end}` : null,
  });
}

/** A Team Bot as the list answers it, with what a test left out as published to the team. */
export function teamBotOf(
  botId: string,
  name: string,
  teamBot: Partial<TeamBot> = {},
): TeamBot {
  return {
    botId,
    name,
    title: "",
    roleDescription: "",
    mine: true,
    audience: "team",
    publishedAt: "2026-10-01T00:00:00Z",
    assigned: false,
    visibleToTeam: true,
    people: [],
    groups: [],
    assignedGroups: [],
    ...teamBot,
  };
}

/**
 * The server's answer to the app's read of the Team Bots list, or undefined for any other request.
 * Every one on the first page.
 */
export function answerTeamBots(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  teamBots: readonly TeamBot[],
): Response | undefined {
  const url = new URL(String(input), "http://openbot.invalid");
  if (url.pathname !== TEAM_BOTS_PATH) return undefined;
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  return NativeResponse.json({ teamBots, nextCursor: null });
}

/** What publishing or assigning a Team Bot answers: it, and no shared app waiting on an admin. */
export function publishedTeamBotResponse(teamBot: TeamBot): Response {
  return NativeResponse.json({
    teamBot,
    sharedApps: { approved: [], needsApproval: [] },
  });
}
