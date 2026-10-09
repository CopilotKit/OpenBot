import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
export type MemoryRecord = {
  id: string;
  content: string;
  provenance: string;
  sourceId: string | null;
  enabled: boolean;
  reviewState: "unreviewed" | "confirmed" | "edited";
  formedBy: "person" | "import" | "bot";
  formedByAgentId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  observedAt: string | null;
  updatedAt: string;
};
export type MemorySource = {
  id: string;
  title: string;
  agentId: string;
  toolRef: string;
  enabled: boolean;
  syncStatus: "idle" | "running" | "succeeded" | "error";
  syncError: string | null;
  lastSyncAt: string | null;
};
export type MemorySourceTool = {
  ref: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export const memoryKeys = {
  all: ["memory"] as const,
  sources: ["memory", "sources"] as const,
  available: (id: string) => ["memory", "available", id] as const,
};
export const memoriesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.all,
    queryFn: (): Promise<MemoryRecord[]> =>
      client("/api/memory", "memories", { fallback: "Could not load memory" }),
  });
export const memorySourcesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.sources,
    queryFn: (): Promise<MemorySource[]> =>
      client("/api/memory/sources", "sources", {
        fallback: "Could not load memory sources",
      }),
    refetchInterval: 15_000,
  });
export const availableMemorySourcesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: memoryKeys.available(id),
    enabled: !!id,
    queryFn: (): Promise<MemorySourceTool[]> =>
      client(
        `/api/memory/sources/available/${encodeURIComponent(id)}`,
        "tools",
        { fallback: "Could not load connected app actions" },
      ),
  });
export const createMemory = (content: string) =>
  client("/api/memory", {
    method: "POST",
    body: { content },
    fallback: "Could not remember this fact",
  });
export const updateMemory = (
  id: string,
  input: { content?: string; enabled?: boolean; reviewState?: "confirmed" },
) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "Could not update memory",
  });
export const deleteMemory = (id: string) =>
  client(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not forget this memory",
  });
export const addMemorySource = (input: {
  agentId: string;
  toolRef: string;
  title: string;
  args: Record<string, unknown>;
}) =>
  client("/api/memory/sources", {
    method: "POST",
    body: input,
    fallback: "Could not add this source",
  });
export const memorySourceAction = (
  id: string,
  action: "sync" | "remove" | "enable" | "disable",
) =>
  client(
    `/api/memory/sources/${encodeURIComponent(id)}${action === "sync" ? "/sync" : ""}`,
    {
      method:
        action === "sync" ? "POST" : action === "remove" ? "DELETE" : "PATCH",
      ...(action === "enable" || action === "disable"
        ? { body: { enabled: action === "enable" } }
        : {}),
      fallback: "Could not change this source",
    },
  );

const settleMemory = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: memoryKeys.all });

export const createMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createMemory,
    onSettled: settleMemory(queryClient),
  });
export const updateMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { content?: string; enabled?: boolean; reviewState?: "confirmed" };
    }) => updateMemory(id, input),
    onSettled: settleMemory(queryClient),
  });
export const deleteMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: deleteMemory,
    onSettled: settleMemory(queryClient),
  });
