import type {
  LearningSpaceState,
  MediaRecord,
} from "@openbot/shared/recorder-api";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { SkillFormValues } from "@/lib/skills/form";

export type DemonstrationDraft = SkillFormValues & {
  requiredTools: string[];
  sourceRecordingId: string;
};

/** What the newest trajectory's last pass found about the Bot's Learning space, or null before the first pass. */
export type DemonstrationLearningState = LearningSpaceState["state"];

/** A demonstration as the list reads it: the step count, never the steps. */
export type DemonstrationSummary = {
  id: string;
  botId: string;
  title: string;
  /** Where it was recorded: the Bot's own browser, or the OpenBot Recorder in the person's browser. */
  source: "computer" | "extension";
  status: "recording" | "stopped" | "drafted" | "published";
  actionCount: number;
  learningState: DemonstrationLearningState | null;
  /** The completed screen, audio and network recordings. */
  media: { id: string; kind: MediaRecord["kind"] }[];
  draft: DemonstrationDraft | null;
  skillSlug: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** When the server stops a recording made in the Bot's browser; null for one made in the person's browser. */
  expiresAt: string | null;
  maxDurationMs: number | null;
  /** Whether the server's time limit, not a person, ended it. */
  reachedTimeLimit: boolean;
};

export type DemonstrationPage = {
  demonstrations: DemonstrationSummary[];
  /** The oldest row's creation time when the page is full, else null. */
  nextBefore: string | null;
};

/** A routine made from a published demonstration skill. */
export type DemonstrationRoutine = {
  id: string;
  agentId: string;
  channelId: string;
  cron: string;
  timezone: string;
  instruction: string;
  nextRunAt: string;
};

export const demonstrationKeys = {
  all: ["demonstrations"] as const,
  bot: (botId: string) => ["demonstrations", botId] as const,
  infinite: (botId: string) => ["demonstrations", botId, "infinite"] as const,
};

const FALLBACK = "Could not load demonstrations";

const listPath = (botId: string, before?: string) =>
  `/api/demonstrations?botId=${encodeURIComponent(botId)}${
    before ? `&before=${encodeURIComponent(before)}` : ""
  }`;

/** The newest page, which the computer view reads. It polls only while a recording is running. */
export const demonstrationsQueryOptions = (botId: string) =>
  queryOptions({
    queryKey: demonstrationKeys.bot(botId),
    queryFn: (): Promise<DemonstrationSummary[]> =>
      client(listPath(botId), "demonstrations", { fallback: FALLBACK }),
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === "recording")
        ? 2000
        : false,
  });

/** Every page of a Bot's demonstrations, newest first, for "Show older recordings". */
export const demonstrationsInfiniteQueryOptions = (botId: string) =>
  infiniteQueryOptions({
    queryKey: demonstrationKeys.infinite(botId),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<DemonstrationPage> => {
      const response = await client(listPath(botId, pageParam || undefined), {
        fallback: FALLBACK,
      });
      return (await response.json()) as DemonstrationPage;
    },
    getNextPageParam: (page: DemonstrationPage) => page.nextBefore ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.demonstrations.some((row) => row.status === "recording"),
      )
        ? 2000
        : false,
  });
