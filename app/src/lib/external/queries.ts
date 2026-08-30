import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { Message } from "@ag-ui/core";

export type ExternalThreadTarget = {
  threadId: string;
  agentId: string;
  agentName: string;
  provider: "slack";
  readOnly: true;
};

export type ExternalThreadSummary = ExternalThreadTarget & {
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};

export type ExternalThreadPage = {
  threads: ExternalThreadSummary[];
  nextCursor: string | null;
};

export const externalThreadKeys = {
  all: ["external-threads"] as const,
  list: () => ["external-threads", "list"] as const,
  detail: (threadId: string) =>
    ["external-threads", "detail", threadId] as const,
};

const EXTERNAL_THREAD_ERROR = "Could not load this Slack conversation.";
const EXTERNAL_THREAD_LIST_ERROR = "Could not load Slack conversations.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function externalThreadTarget(value: unknown): ExternalThreadTarget {
  if (!isRecord(value)) {
    throw new Error(EXTERNAL_THREAD_ERROR);
  }
  const target = value as Partial<ExternalThreadTarget>;
  if (
    !isNonEmptyString(target.threadId) ||
    !isNonEmptyString(target.agentId) ||
    !isNonEmptyString(target.agentName) ||
    target.provider !== "slack" ||
    target.readOnly !== true
  ) {
    throw new Error(EXTERNAL_THREAD_ERROR);
  }
  return target as ExternalThreadTarget;
}

function externalThreadSummary(value: unknown): ExternalThreadSummary {
  let target: ExternalThreadTarget;
  try {
    target = externalThreadTarget(value);
  } catch {
    throw new Error(EXTERNAL_THREAD_LIST_ERROR);
  }
  const summary = value as Partial<ExternalThreadSummary>;
  if (
    (summary.lastMessage !== null && typeof summary.lastMessage !== "string") ||
    (summary.lastMessageAt !== null && !isTimestamp(summary.lastMessageAt)) ||
    !isTimestamp(summary.createdAt)
  ) {
    throw new Error(EXTERNAL_THREAD_LIST_ERROR);
  }
  return {
    ...target,
    lastMessage: summary.lastMessage,
    lastMessageAt: summary.lastMessageAt,
    createdAt: summary.createdAt,
  };
}

export function externalThreadPage(value: unknown): ExternalThreadPage {
  if (!isRecord(value) || !Array.isArray(value.threads)) {
    throw new Error(EXTERNAL_THREAD_LIST_ERROR);
  }
  const nextCursor = value.nextCursor;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    throw new Error(EXTERNAL_THREAD_LIST_ERROR);
  }
  return {
    threads: value.threads.map(externalThreadSummary),
    nextCursor,
  };
}

export function externalThreadListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: externalThreadKeys.list(),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<ExternalThreadPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam as string)}`
        : "";
      const response = await client(`/api/external-links/threads${suffix}`, {
        fallback: EXTERNAL_THREAD_LIST_ERROR,
      });
      return externalThreadPage(await response.json());
    },
    getNextPageParam: (page: ExternalThreadPage) =>
      page.nextCursor ?? undefined,
    select: (data): ExternalThreadSummary[] =>
      data.pages.flatMap((page) => page.threads),
  });
}

export async function readExternalThreadMessages(
  threadId: string,
): Promise<readonly Message[]> {
  const response = await client(
    `/api/external-links/threads/${encodeURIComponent(threadId)}/messages`,
    { fallback: "Could not load this Slack conversation" },
  );
  const value = (await response.json()) as { messages?: unknown };
  return Array.isArray(value.messages) ? (value.messages as Message[]) : [];
}

export function externalThreadQueryOptions(threadId: string) {
  return queryOptions({
    queryKey: externalThreadKeys.detail(threadId),
    queryFn: async () => {
      const response = await client(
        `/api/external-links/threads/${encodeURIComponent(threadId)}`,
        { fallback: EXTERNAL_THREAD_ERROR },
      );
      return externalThreadTarget(await response.json());
    },
  });
}
