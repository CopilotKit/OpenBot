import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  createCheckIn,
  deleteCheckIn,
  dismissCheckInItem,
  listCheckInItems,
  listCheckIns,
  runCheckIn,
  startCheckInItem,
  updateCheckIn,
} from "@/lib/api/generated/check-ins/check-ins";
import type {
  LastCheckIn as ApiLastCheckIn,
  CheckIn,
  CheckInItem,
  CheckInRunAnswer,
  CreateCheckInRequest,
  UpdateCheckInRequest,
} from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { everyPage } from "@/lib/routines/queries";
import { taskKeys } from "@/lib/tasks/queries";

/**
 * A Bot's newest check-in, from the run ledger: how it ended, and for one that was skipped or
 * couldn't finish, why, in one sentence the server wrote for the person. Null before the first.
 * The API's `LastCheckIn`.
 */
export type LastCheckIn = ApiLastCheckIn;

/**
 * One thing a Bot checks in on for the person: the API's `CheckIn`. `subject` is what it watches,
 * in the person's words, and is empty on one that watches everything the Bot reads.
 */
export type ProactiveSetting = CheckIn;

/**
 * What Run now answered: queued, or skipped at once (`skipped` and `why` say for what reason a
 * check-in would have been skipped anyway). A Run now that can't be tried (one is running, or one
 * ran in the last ten minutes) is refused, and the client raises the server's sentence.
 */
export type RunNowAnswer = CheckInRunAnswer;

/**
 * What `listCheckIns` answers, every page read. `allowed` is false when an admin turned check-ins
 * off for this person, so their own switches can say who turned them off.
 */
type ProactiveSettingsBody = {
  settings: ProactiveSetting[];
  allowed: boolean;
};

/**
 * Something a Bot's check-in found that needs the person: what it is, why (`detail`), and where it
 * read that. Open items only; Start and Hide take it off the list. The API's `CheckInItem`.
 *
 * A new item always names its source. Items from before check-ins may not, so `sourceApp` and
 * `sourceRef` stay nullable. `checkInId` is the check-in that found it. `pingId` is the ping that
 * told the person about it, null while it waits for their hourly slot; the list shows it either way.
 */
export type ProactiveSuggestion = CheckInItem;

/**
 * The site an item's link opens, as its Open button names it: the link's own host, without "www.".
 * Never the app the Bot read it with, which is often not where the link goes: a web search finds a
 * page on another site, and "Open in Exa Search" over a link to bun.com sent people somewhere else.
 * Null for a link that won't parse.
 */
export function sourceSite(link: string): string | null {
  try {
    return new URL(link).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export const proactiveKeys = {
  settings: ["proactive", "settings"] as const,
  suggestions: ["proactive", "suggestions"] as const,
};

/*
 * One read of the person's check-ins answers two questions: which Bots check in, and whether an
 * admin allows it at all. Both factories share the key, so they are one request, and each component
 * sees only the half it asked for. `allowed` is on every page; the first one's is read.
 */
const proactiveSettingsQuery = {
  queryKey: proactiveKeys.settings,
  queryFn: async ({
    signal,
  }: {
    signal?: AbortSignal;
  }): Promise<ProactiveSettingsBody> => {
    let allowed: boolean | undefined;
    const settings = await everyPage(async (params) => {
      const page = await listCheckIns(organizationId(), params, {
        signal,
        fallback: "Couldn't load your check-ins",
      });
      allowed ??= page.allowed;
      return { items: page.checkIns, nextCursor: page.nextCursor };
    });
    return { settings, allowed: allowed ?? true };
  },
  refetchInterval: 30_000,
};

export const proactiveSettingsQueryOptions = () =>
  queryOptions({
    ...proactiveSettingsQuery,
    select: (body): ProactiveSetting[] => body.settings,
  });

/** Whether an admin lets this person's Bots check in. */
export const proactiveAllowedQueryOptions = () =>
  queryOptions({
    ...proactiveSettingsQuery,
    select: (body): boolean => body.allowed,
  });

export const proactiveSuggestionsQueryOptions = () =>
  queryOptions({
    queryKey: proactiveKeys.suggestions,
    queryFn: ({ signal }): Promise<ProactiveSuggestion[]> =>
      everyPage(async (params) => {
        const page = await listCheckInItems(organizationId(), params, {
          signal,
          fallback: "Couldn't load what your Bots found",
        });
        return { items: page.checkInItems, nextCursor: page.nextCursor };
      }),
    refetchInterval: 30_000,
  });

/**
 * A fresh key for each write a person asks for. TanStack does not retry a mutation, so each attempt
 * is a new write; a retry of the same write would reuse its key.
 */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/**
 * A check-in for a Bot. One on a thing the Bot already watches (the same link, or the same subject)
 * is turned back on with what was sent, which is what accepting an offer means. `refuseExisting` is
 * for a screen that asked for a new one: the server refuses that with 409 and says why.
 */
export const createProactiveSetting = (
  input: CreateCheckInRequest,
  { refuseExisting = false }: { refuseExisting?: boolean } = {},
) =>
  createCheckIn(
    organizationId(),
    input,
    once(),
    refuseExisting ? { refuseExisting } : undefined,
    { fallback: "Couldn't turn on check-ins" },
  );
export const updateProactiveSetting = (
  id: string,
  input: UpdateCheckInRequest,
) =>
  updateCheckIn(organizationId(), id, input, once(), {
    fallback: "Couldn't change check-ins",
  });
export const runProactiveNow = (id: string): Promise<RunNowAnswer> =>
  runCheckIn(organizationId(), id, once(), {
    fallback: "Couldn't start a check-in",
  });
export const removeProactiveSetting = (id: string) =>
  deleteCheckIn(organizationId(), id, once(), {
    fallback: "Couldn't remove check-ins",
  });

/**
 * Start an item as a task in a conversation of its own, or Hide it. The server answers a second
 * Start with the task the first one opened, so a double tap starts one task. The task arrives on the
 * lists through the tasks query, so nothing here reads the answer.
 */
export const resolveSuggestion = async (
  id: string,
  action: "start" | "dismiss",
): Promise<void> => {
  if (action === "start")
    await startCheckInItem(organizationId(), id, once(), {
      fallback: "Couldn't start this. Try again.",
    });
  else
    await dismissCheckInItem(organizationId(), id, once(), {
      fallback: "Couldn't hide this. Try again.",
    });
};

/** A setting's check-ins produce items, so a change to either refreshes both. */
const settleProactive = (queryClient: QueryClient) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
  ]);

/**
 * Start an item as a task, or Hide it. Either takes it off every list at once: the Bots page, the
 * Bot's page and the skins all read the one suggestions query. Start also opens a task, and both move
 * the counts on the sidebar's badge, so the tasks and the attention counts are read again too.
 */
export const resolveSuggestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: () =>
      Promise.all([
        settleProactive(queryClient)(),
        queryClient.invalidateQueries({ queryKey: taskKeys.all }),
        queryClient.invalidateQueries({
          queryKey: botLifecycleKeys.attention,
        }),
      ]),
  });

export const createProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: (input: Parameters<typeof createProactiveSetting>[0]) =>
      createProactiveSetting(input),
    onSuccess: settleProactive(queryClient),
  });

/** What can be done to one Bot's check-ins from its row. */
export type ProactiveChange =
  | { kind: "toggle" }
  | { kind: "run" }
  | { kind: "remove" }
  | { kind: "interval"; minutes: number };

/** Every change to a check-in, Remove included, so its page can tell it was removed from there. */
export const changeProactiveSettingMutationKey = [
  ...proactiveKeys.settings,
  "change",
] as const;

export const changeProactiveSettingMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationKey: changeProactiveSettingMutationKey,
    /** Run now's answer, for the row to say what became of it; nothing for any other change. */
    mutationFn: async ({
      setting,
      change,
    }: {
      setting: Pick<ProactiveSetting, "id" | "enabled">;
      change: ProactiveChange;
    }): Promise<RunNowAnswer | null> => {
      if (change.kind === "run") return runProactiveNow(setting.id);
      if (change.kind === "remove") await removeProactiveSetting(setting.id);
      else
        await updateProactiveSetting(
          setting.id,
          change.kind === "toggle"
            ? { enabled: !setting.enabled }
            : { intervalMinutes: change.minutes },
        );
      return null;
    },
    onSuccess: settleProactive(queryClient),
  });
