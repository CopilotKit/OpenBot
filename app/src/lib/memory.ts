import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  createMemory as createMemoryOperation,
  createMemorySource,
  deleteMemory as deleteMemoryOperation,
  deleteMemorySource,
  listMemories,
  listMemorySources,
  listMemorySourceTools,
  syncMemorySource,
  updateMemory as updateMemoryOperation,
  updateMemorySource,
} from "@/lib/api/generated/memory/memory";
import type {
  MemorySource as ApiMemorySource,
  MemorySourceTool as ApiMemorySourceTool,
  CreateMemorySourceRequest,
  Memory,
  UpdateMemoryRequest,
} from "@/lib/api/generated/model";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { everyPage } from "@/lib/routines/queries";

/** Memory is always the signed-in person's own: the API addresses them as `me`. */
const ME = "me";

/**
 * One fact the person's Bots remember about them, as the API answers it. `formedBy` says who formed
 * it; `intelligence` is one held by CopilotKit Intelligence for this person, formed outside OpenBot.
 */
export type MemoryRecord = Memory;
/** One app action a Bot reads facts in from: the API's `MemorySource`, with the Bot as `botId`. */
export type MemorySource = ApiMemorySource;
/** One of a Bot's read actions it could read facts in from. */
export type MemorySourceTool = ApiMemorySourceTool;

export const memoryKeys = {
  all: ["memory"] as const,
  sources: ["memory", "sources"] as const,
  available: (id: string) => ["memory", "available", id] as const,
};

/** Every memory the person's Bots hold about them, read to the end of the list. */
export const memoriesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.all,
    queryFn: ({ signal }): Promise<MemoryRecord[]> =>
      everyPage(async (params) => {
        const page = await listMemories(ORGANIZATION_ID, ME, params, {
          signal,
          fallback: "Could not load memory",
        });
        return { items: page.memories, nextCursor: page.nextCursor };
      }),
  });

/** Every source the person's Bots read facts in from. */
export const memorySourcesQueryOptions = () =>
  queryOptions({
    queryKey: memoryKeys.sources,
    queryFn: ({ signal }): Promise<MemorySource[]> =>
      everyPage(async (params) => {
        const page = await listMemorySources(ORGANIZATION_ID, ME, params, {
          signal,
          fallback: "Could not load memory sources",
        });
        return { items: page.sources, nextCursor: page.nextCursor };
      }),
    refetchInterval: 15_000,
  });

/** The read actions one Bot could read facts in from. */
export const availableMemorySourcesQueryOptions = (botId: string) =>
  queryOptions({
    queryKey: memoryKeys.available(botId),
    enabled: !!botId,
    queryFn: ({ signal }): Promise<MemorySourceTool[]> =>
      everyPage(async (params) => {
        const page = await listMemorySourceTools(
          ORGANIZATION_ID,
          botId,
          params,
          { signal, fallback: "Could not load connected app actions" },
        );
        return { items: page.tools, nextCursor: page.nextCursor };
      }),
  });

export const createMemory = (content: string) =>
  createMemoryOperation(
    ORGANIZATION_ID,
    ME,
    { content },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Could not remember this fact" },
  );

export type MemoryChange = Pick<
  UpdateMemoryRequest,
  "content" | "enabled" | "reviewState"
>;

export const updateMemory = (id: string, input: MemoryChange) =>
  updateMemoryOperation(
    ORGANIZATION_ID,
    ME,
    id,
    input,
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Could not update memory" },
  );

export const deleteMemory = (id: string) =>
  deleteMemoryOperation(
    ORGANIZATION_ID,
    ME,
    id,
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Could not forget this memory" },
  );

/** Start reading one of a Bot's connected apps' actions as a memory source, and read it once now. */
export const addMemorySource = (input: CreateMemorySourceRequest) =>
  createMemorySource(
    ORGANIZATION_ID,
    ME,
    input,
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Could not add this source" },
  );

const SOURCE_FALLBACK = "Could not change this source";

/** Sync, remove, turn on or turn off one memory source. */
export async function memorySourceAction(
  id: string,
  action: "sync" | "remove" | "enable" | "disable",
): Promise<void> {
  const headers = { "Idempotency-Key": idempotencyKey() };
  const options = { fallback: SOURCE_FALLBACK };
  if (action === "sync")
    await syncMemorySource(ORGANIZATION_ID, ME, id, headers, options);
  else if (action === "remove")
    await deleteMemorySource(ORGANIZATION_ID, ME, id, headers, options);
  else
    await updateMemorySource(
      ORGANIZATION_ID,
      ME,
      id,
      { enabled: action === "enable" },
      headers,
      options,
    );
}

const settleMemory = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: memoryKeys.all });

export const createMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createMemory,
    onSettled: settleMemory(queryClient),
  });
export const updateMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, input }: { id: string; input: MemoryChange }) =>
      updateMemory(id, input),
    onSettled: settleMemory(queryClient),
  });
export const deleteMemoryMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: deleteMemory,
    onSettled: settleMemory(queryClient),
  });

/** Opt a Bot in to reading one of its connected apps' actions as a memory source. */
export const addMemorySourceMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: addMemorySource,
    onSuccess: settleMemory(queryClient),
  });

/** Sync, remove, enable or disable one memory source. */
export const memorySourceActionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      sourceId,
      name,
    }: {
      sourceId: string;
      name: "sync" | "remove" | "enable" | "disable";
    }) => memorySourceAction(sourceId, name),
    onSuccess: settleMemory(queryClient),
  });
