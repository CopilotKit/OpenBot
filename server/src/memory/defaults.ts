/**
 * Memory and background research, on by default.
 *
 * Both used to start only when a person set them up by hand, one Bot and one app at a time, so on a
 * fresh deployment a Bot remembered what it was told and nothing else. Now:
 *
 * - A person who talks to one of their Bots in a conversation with that Bot alone gets background
 *   research from it: the same read-only run (`proactive/restriction.ts`), every four hours, first
 *   run one interval after the conversation so it never races it. Suggestions land in that
 *   conversation.
 * - Each app the person connected in their own account, that the Bot can read, becomes a memory
 *   source for that Bot: one per app, read as the person, through the same authorization a source
 *   made by hand passes (`MemoryIngestion.defaultSourceCandidates`).
 *
 * Isolation is unchanged, because nothing here is a new path to a memory: a default source is an
 * ordinary `memory_sources` row owned by the person and bound to one Bot, and what it imports is
 * recalled by that Bot only, unreviewed until the person confirms it (so not mirrored to
 * Intelligence until then). A default research setting is an ordinary `proactive_settings` row.
 *
 * NEVER SWITCHED BACK ON. Turning either off keeps its row with `enabled = false`, and a row of any
 * kind means there is nothing to adopt. Removing one writes `default_opt_outs`, which adoption reads
 * first. Both checks and the insert run under one advisory lock per person and Bot, which removal
 * takes too, so a removal and an adoption arriving together cannot interleave into a re-creation.
 * Removal waits for the lock; adoption only tries it and steps aside when it is held, so it never
 * parks a pooled connection behind another transaction.
 *
 * Off for the whole deployment with OPENBOT_MEMORY_SOURCE_DEFAULTS=false and
 * OPENBOT_PROACTIVE_DEFAULTS=false. Either switch stops new defaults; neither touches existing rows.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { type DefaultFeature, defaultOptOuts } from "../db/schema/defaults";
import { memorySources } from "../db/schema/memory";
import { proactiveSettings } from "../db/schema/proactive";
import type { MemoryIngestion } from "./ingestion";

/** How often background research runs when OpenBot switched it on, in minutes. */
export const DEFAULT_RESEARCH_INTERVAL_MINUTES = 240;
/** The shortest gap between two adoption passes for one person and Bot in this process. */
const MIN_INTERVAL_MS = 5 * 60_000;

/** A transaction or the database: anything that can run the statements below. */
type Executor = Pick<Database, "execute" | "select" | "insert" | "delete">;

const lockKey = (ownerUserId: string, agentId: string) =>
  `openbot:defaults:${ownerUserId}:${agentId}`;

/**
 * Take the per-person, per-Bot lock adoption and removal share, waiting for it. Removal uses this: a
 * person's removal always lands. Transaction-scoped: held until the caller's transaction ends.
 */
export async function lockDefaults(
  executor: Pick<Database, "execute">,
  ownerUserId: string,
  agentId: string,
) {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${lockKey(ownerUserId, agentId)}))`,
  );
}

/**
 * The same lock without waiting, for adoption. Held by anyone else means a removal or another adoption
 * for this pair is in flight, and either one settles the question, so adoption steps aside rather than
 * hold a pooled connection while it waits.
 */
async function tryLockDefaults(
  executor: Pick<Database, "execute">,
  ownerUserId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await executor.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext(${lockKey(ownerUserId, agentId)})) as locked`,
  );
  return [...rows][0]?.locked === true;
}

/** Record that a person turned a default down. Idempotent. */
export async function recordOptOut(
  executor: Pick<Database, "insert">,
  input: {
    ownerUserId: string;
    agentId: string;
    feature: DefaultFeature;
    scope?: string;
  },
) {
  await executor
    .insert(defaultOptOuts)
    .values({ ...input, scope: input.scope ?? "" })
    .onConflictDoNothing();
}

/** The app half of a tool ref, which is what a memory-source opt-out is scoped to. */
export function sourceServerId(toolRef: string) {
  return toolRef.split("/")[0] ?? toolRef;
}

async function declined(
  executor: Executor,
  ownerUserId: string,
  agentId: string,
  feature: DefaultFeature,
) {
  const rows = await executor
    .select({ scope: defaultOptOuts.scope })
    .from(defaultOptOuts)
    .where(
      and(
        eq(defaultOptOuts.ownerUserId, ownerUserId),
        eq(defaultOptOuts.agentId, agentId),
        eq(defaultOptOuts.feature, feature),
      ),
    );
  return new Set(rows.map((row) => row.scope));
}

export type MemoryDefaults = ReturnType<typeof createMemoryDefaults>;

export function createMemoryDefaults(options: {
  database: Database;
  ingestion: Pick<MemoryIngestion, "defaultSourceCandidates" | "sync">;
  /** OPENBOT_MEMORY_SOURCE_DEFAULTS, on unless switched off. */
  sources: boolean;
  /** OPENBOT_PROACTIVE_DEFAULTS, on unless switched off. */
  research: boolean;
  /** The Bots in this person's conversation, or null when it is not theirs. */
  channelBots(ownerUserId: string, channelId: string): Promise<string[] | null>;
  /** Whether research from this Bot may be delivered to this conversation (see `deliveryScopeFor`). */
  canDeliver(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<boolean>;
  mintThreadId(): string;
  /**
   * A Team Bot somebody else published uses a person's own accounts only with their consent
   * (team-bots.ts), so none of their apps becomes its memory source by default. They can add one.
   */
  publishedByAnother?(ownerUserId: string, agentId: string): Promise<boolean>;
  now?: () => number;
  minIntervalMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const log = options.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const lastRun = new Map<string, number>();

  /** True at most once per `minIntervalMs` for one key, so a busy conversation adopts once. */
  const due = (key: string) => {
    const at = now();
    const previous = lastRun.get(key);
    if (previous !== undefined && at - previous < minIntervalMs) return false;
    lastRun.set(key, at);
    // Bounded: an old key is worth nothing once its interval has passed.
    if (lastRun.size > 10_000)
      for (const [stale, when] of lastRun)
        if (at - when >= minIntervalMs) lastRun.delete(stale);
    return true;
  };

  const failed = (operation: string) => (error: unknown) =>
    log({
      type: "memory-defaults-error",
      operation,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    });

  /** Switch on a memory source for each connected app the Bot can read. Returns the new ids. */
  async function adoptSources(
    ownerUserId: string,
    agentId: string,
  ): Promise<string[]> {
    if (!options.sources) return [];
    if (await options.publishedByAnother?.(ownerUserId, agentId)) return [];
    const candidates = await options.ingestion.defaultSourceCandidates(
      ownerUserId,
      agentId,
    );
    if (!candidates.length) return [];
    const created = await options.database.transaction(async (transaction) => {
      if (!(await tryLockDefaults(transaction, ownerUserId, agentId)))
        return [];
      const existing = await transaction
        .select({ toolRef: memorySources.toolRef })
        .from(memorySources)
        .where(
          and(
            eq(memorySources.ownerUserId, ownerUserId),
            eq(memorySources.agentId, agentId),
          ),
        );
      const covered = new Set(
        existing.map((row) => sourceServerId(row.toolRef)),
      );
      const optedOut = await declined(
        transaction,
        ownerUserId,
        agentId,
        "memory_source",
      );
      const ids: string[] = [];
      for (const candidate of candidates) {
        // Any source on this app, on or off, made by hand or by us, is the person's choice already.
        if (covered.has(candidate.serverId) || optedOut.has(candidate.serverId))
          continue;
        const id = randomUUID();
        await transaction.insert(memorySources).values({
          id,
          ownerUserId,
          agentId,
          toolRef: candidate.toolRef,
          title: candidate.title,
          args: {},
        });
        covered.add(candidate.serverId);
        ids.push(id);
      }
      return ids;
    });
    for (const id of created) {
      log({
        type: "memory-defaults",
        outcome: "source_adopted",
        sourceId: id,
        timestamp: new Date().toISOString(),
      });
      // Read now rather than on the next sweep, so the Bot has the facts by the person's next turn.
      void options.ingestion.sync(ownerUserId, id).catch(failed("sync"));
    }
    return created;
  }

  /** Switch on background research by this Bot into this conversation. True when it did. */
  async function adoptResearch(
    ownerUserId: string,
    agentId: string,
    channelId: string,
  ): Promise<boolean> {
    if (!options.research) return false;
    if (!(await options.canDeliver(ownerUserId, channelId, agentId)))
      return false;
    const adopted = await options.database.transaction(async (transaction) => {
      if (!(await tryLockDefaults(transaction, ownerUserId, agentId)))
        return false;
      if (
        (
          await declined(
            transaction,
            ownerUserId,
            agentId,
            "proactive_research",
          )
        ).size
      )
        return false;
      const rows = await transaction
        .insert(proactiveSettings)
        .values({
          id: randomUUID(),
          ownerUserId,
          agentId,
          channelId,
          threadId: options.mintThreadId(),
          intervalMinutes: DEFAULT_RESEARCH_INTERVAL_MINUTES,
          enabled: true,
          nextRunAt: new Date(
            now() + DEFAULT_RESEARCH_INTERVAL_MINUTES * 60_000,
          ),
        })
        // One per person and Bot: a row already there, on or off, is the person's choice.
        .onConflictDoNothing()
        .returning({ id: proactiveSettings.id });
      return rows.length > 0;
    });
    if (adopted)
      log({
        type: "memory-defaults",
        outcome: "research_adopted",
        agentId,
        timestamp: new Date().toISOString(),
      });
    return adopted;
  }

  return {
    adoptSources,
    adoptResearch,
    /**
     * A person said something in one of their conversations. When it is a conversation with one
     * Bot, switch on that Bot's defaults. Never waits and never throws.
     */
    personSpoke(ownerUserId: string, channelId: string) {
      if (!options.sources && !options.research) return;
      if (!due(`channel:${ownerUserId}:${channelId}`)) return;
      void (async () => {
        const bots = await options.channelBots(ownerUserId, channelId);
        // A group conversation would put research in front of Bots nobody asked.
        if (bots?.length !== 1) return;
        const [agentId] = bots as [string];
        await adoptResearch(ownerUserId, agentId, channelId).catch(
          failed("research"),
        );
        if (due(`bot:${ownerUserId}:${agentId}`))
          await adoptSources(ownerUserId, agentId).catch(failed("sources"));
      })().catch(failed("personSpoke"));
    },
    /** A turn by this Bot for this person is starting: pick up apps connected since. Never waits. */
    botTurn(ownerUserId: string, agentId: string) {
      if (!options.sources) return;
      if (!due(`bot:${ownerUserId}:${agentId}`)) return;
      void adoptSources(ownerUserId, agentId).catch(failed("sources"));
    },
  };
}
