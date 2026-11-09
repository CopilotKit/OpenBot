import { createHash } from "node:crypto";
import type { Tool } from "@ag-ui/client";
import {
  formatSkillCatalog,
  loadSkill,
  readSkillFile,
  SkillRegistry,
  type SnapshotSkill,
  type VerifiedSnapshot,
} from "@copilotkit/runtime/internal/learned-skills";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type {
  LearnedSkillContent,
  LearningDeliveryStatus,
  LearningSettings,
  LearningTarget,
} from "@openbot/shared/learning";
import { z } from "zod";
import type { LearningSettingsStore } from "./settings";
import type { OpenSkillSource } from "./sharing";

// This published internal export is pinned with @copilotkit/runtime in server/package.json. Keep its use here: the SDK owns
// archive verification, refresh, revocation and stale-cache policy for every OpenBot framework.
export type LearnedSkillInvocation = {
  readonly catalog: string;
  readonly tools: readonly Tool[];
  execute(name: string, args: unknown): Promise<string>;
};
/**
 * The learned Skills one run of `agentId` may use. With `userId`, the person the run is for: their own Learning space's
 * Skills and, while an administrator allows Skill sharing, every Skill another person opened join the Bot's own
 * (`mergeLearnedSkills`). Callers never pass `userId` themselves: `agents/agent-resolver.ts` binds the person a Bot is
 * built for, and every path that builds one (a chat turn, a routine, a channel, a hop) goes through it.
 */
export type AcquireLearnedSkills = (
  agentId: string,
  signal?: AbortSignal,
  userId?: string,
) => Promise<LearnedSkillInvocation | undefined>;

export const LEARNED_SKILL_TOOL_NAMES = new Set([
  "copilotkit_load_skill",
  "copilotkit_read_skill_file",
]);
const skillArgs = z.object({ skill_name: z.string().min(1) }).strict();
const fileArgs = skillArgs.extend({ path: z.string().min(1) }).strict();
const skillTools: readonly Tool[] = [
  {
    name: "copilotkit_load_skill",
    description:
      "Load a published learned Skill's instructions and supporting file names.",
    parameters: z.toJSONSchema(skillArgs),
  },
  {
    name: "copilotkit_read_skill_file",
    description:
      "Read one supporting text file from a published learned Skill.",
    parameters: z.toJSONSchema(fileArgs),
  },
];

/** Whether an administrator excluded this Bot from Automatic Learning (a per-Bot mapping of null). */
function excludedFromLearning(
  settings: LearningSettings,
  agentId: string,
): boolean {
  return (
    Object.hasOwn(settings.agents, agentId) && settings.agents[agentId] === null
  );
}

/** Skills another person opened, the ones among them they approved only for themselves, and their space's snapshot. */
export type OpenedSkills = {
  source: OpenSkillSource;
  /** Read fresh for this run (`PersonalSkillSources.withheld`), never from the open-Skill index. */
  withheld: ReadonlySet<string>;
  snapshot: VerifiedSnapshot;
};

/**
 * One run's Skills from up to three places, in this order of precedence when two share a name:
 *
 * 1. The Bot's own (its Learning target, as before). Always kept as they are.
 * 2. The run's person's own space. A Skill whose name the Bot already has is left out: the Bot's own wins.
 * 3. Skills other people opened (`open`, or picked under `choose`), never one the person withheld. One whose name the Bot
 *    or the person already has is left out. When two or more people opened a Skill with the same name, all of them are
 *    kept, each named `<their space id>/<name>` (the SDK's own multi-container naming), so none is lost and the choice
 *    never depends on timing; a name only one person opened keeps its plain name.
 *
 * Nothing merged is the Bot's own snapshot unchanged.
 */
export function mergeLearnedSkills(input: {
  bot?: VerifiedSnapshot;
  own?: VerifiedSnapshot;
  opened?: readonly OpenedSkills[];
}): VerifiedSnapshot | undefined {
  const opened = input.opened ?? [];
  if (!input.own && opened.length === 0) return input.bot;
  const skills: SnapshotSkill[] = [...(input.bot?.skills ?? [])];
  const taken = new Set(skills.map((skill) => skill.name));
  for (const skill of input.own?.skills ?? []) {
    if (taken.has(skill.name)) continue;
    skills.push(skill);
    taken.add(skill.name);
  }
  const candidates = opened
    .flatMap(({ source, withheld, snapshot }) =>
      snapshot.skills
        .filter(
          (skill) =>
            (source.skills === "all" || source.skills.has(skill.name)) &&
            !withheld.has(skill.name),
        )
        .map((skill) => ({ containerId: source.containerId, skill })),
    )
    .filter(({ skill }) => !taken.has(skill.name))
    .sort(
      (a, b) =>
        a.skill.name.localeCompare(b.skill.name) ||
        a.containerId.localeCompare(b.containerId),
    );
  const owners = new Map<string, number>();
  for (const { skill } of candidates)
    owners.set(skill.name, (owners.get(skill.name) ?? 0) + 1);
  for (const { containerId, skill } of candidates) {
    skills.push(
      (owners.get(skill.name) ?? 0) > 1
        ? Object.freeze({ ...skill, name: `${containerId}/${skill.name}` })
        : skill,
    );
  }
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        input.bot ? [input.bot.revision, input.bot.etag] : null,
        input.own ? [input.own.revision, input.own.etag] : null,
        opened.map(({ source, withheld, snapshot }) => [
          source.containerId,
          snapshot.revision,
          snapshot.etag,
          source.skills === "all" ? "all" : [...source.skills].sort(),
          [...withheld].sort(),
        ]),
      ]),
    )
    .digest("hex");
  return Object.freeze({
    revision: `merged:${identity}`,
    etag: `"${identity}"`,
    skills: Object.freeze(skills),
  });
}

export function selectLearningTarget(
  settings: LearningSettings,
  agentId: string,
): LearningTarget | undefined {
  if (!settings.enabled) return undefined;
  return (
    (Object.hasOwn(settings.agents, agentId)
      ? settings.agents[agentId]
      : settings.defaultTarget) ?? undefined
  );
}

/** Cancel this invocation's wait without cancelling another invocation's shared refresh. */
function waitForSnapshot<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Called once after loadConfig consumes the environment default, before any registry exists. */
export function clearLearningRevisionFallback(
  environment: Record<string, string | undefined> = process.env,
): void {
  delete environment.CPK_INTELLIGENCE_SKILLS_REVISION;
}

export type LearningThread = {
  threadId: string;
  agentId: string;
  userId: string;
};

/**
 * Where a person's own Skills and other people's opened Skills come from. Absent, a run gets only the Bot's own Skills.
 */
export type PersonalSkillSources = {
  /** The person's own Learning space (learning/personal-space.ts). */
  containerFor(userId: string): string;
  /** Everyone's opened Skills, from the in-memory index (learning/sharing.ts), never read per person per run. */
  openSkills(): Promise<readonly OpenSkillSource[]>;
  /**
   * The Skills each of these people approved only for themselves, which must not reach other people's Bots until an
   * administrator approves sharing them (learning/approvals.ts `withheld`). Read on every run that has an opened
   * source, never cached: an approval made through another replica holds a Skill back on the very next run here. A read
   * that fails leaves every opened source out of that run.
   */
  withheld(
    userIds: string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Whether an administrator lets people open their Skills to every Bot (Admin, Automatic learning, Skill sharing).
   * Asked on every run, before the index: while it is off, a Skill somebody opened reaches no other person's Bot, and
   * their choice is kept for when it is on again. A gate that cannot be read counts as off.
   */
  sharingAllowed(): boolean | Promise<boolean>;
};

/** The longest a run waits for a person's or an opened space before going on without it. Its refresh carries on. */
const PERSONAL_WAIT_MS = 2_000;
/** How long Settings, Learning waits for the person's own Skills. */
const PERSONAL_READ_MS = 5_000;
/** A space that refused (missing, revoked, not entitled, unreadable) is not asked again by runs for this long. */
const PERSONAL_RETRY_MS = 60_000;

/** A Skill's files with SKILL.md first and the rest in their given order; a binary file has no text. */
export function skillMdFirst(
  files: readonly { path: string; text?: string }[],
): { path: string; text: string | null }[] {
  return [...files]
    .sort(
      (a, b) => Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md"),
    )
    .map((file) => ({ path: file.path, text: file.text ?? null }));
}

export function createLearningRuntime(options: {
  store: LearningSettingsStore;
  client: CopilotKitIntelligence;
  freshnessWindowMs?: number;
  people?: PersonalSkillSources;
  /** Default 2_000. */
  personalWaitMs?: number;
  now?: () => number;
  /**
   * Whether `containerId` was found missing on this Intelligence: the environment's container,
   * forgotten (`ConfiguredLearningContainer.forgotten` in learning/settings.ts), or the saved
   * default, set aside (`LearningSettingsStore.isSetAside`).
   */
  forgotten?: (containerId: string) => boolean;
}) {
  const { store, client, people } = options;
  const personalWaitMs = options.personalWaitMs ?? PERSONAL_WAIT_MS;
  const now = options.now ?? Date.now;
  const registries = new Map<string, SkillRegistry>();
  /*
   * The settings, for a chat run, or undefined when they cannot be read. A saved row this build
   * cannot read used to fail every run ("Failed to resolve Learning Container"); a run now goes ahead
   * without Learning and the failure is logged. Admin still reads the settings through the store and
   * is told they are invalid. Never logs the thrown value, which can carry row contents.
   */
  const settingsForRun = async (
    operation: "acquire" | "containerForThread",
  ): Promise<LearningSettings | undefined> => {
    try {
      return await store.read();
    } catch {
      console.error({
        error: "learning_settings_unreadable",
        context: { operation, outcome: "run continues without Learning" },
        timestamp: new Date().toISOString(),
      });
      return undefined;
    }
  };
  const registryKey = (target: LearningTarget) =>
    JSON.stringify([target.containerId, target.revision]);
  const registryFor = (target: LearningTarget) => {
    const key = registryKey(target);
    let registry = registries.get(key);
    if (!registry) {
      registry = new SkillRegistry({
        client,
        containerId: target.containerId,
        ...(target.revision ? { revision: target.revision } : {}),
        ...(options.freshnessWindowMs === undefined
          ? {}
          : { freshnessWindowMs: options.freshnessWindowMs }),
      });
      registries.set(key, registry);
    }
    return registry;
  };

  /** Containers whose last read refused, and until when runs leave them alone. */
  const refusedUntil = new Map<string, number>();
  /** One log line per container per refusal window, so a missing space does not write a line per run. */
  const warned = new Map<string, number>();
  /** People whose own space was not there yet, said once each. */
  const notMadeYet = new Set<string>();

  /**
   * A person's or an opened space's snapshot, or undefined. FAILS SOFT: whatever goes wrong (the space is missing,
   * Intelligence is down, the read is slow) the run goes on with the Skills it has, because a person's space must never
   * break a Bot that works without it.
   */
  const softSnapshot = async (
    containerId: string,
    signal?: AbortSignal,
    /** The run's own person's space, which may not have been made yet; an opened one was. */
    own = false,
  ): Promise<VerifiedSnapshot | undefined> => {
    if ((refusedUntil.get(containerId) ?? 0) > now()) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        waitForSnapshot(registryFor({ containerId }).acquireSnapshot(), signal),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), personalWaitMs);
        }),
      ]);
    } catch (error) {
      if (signal?.aborted) return undefined;
      refusedUntil.set(containerId, now() + PERSONAL_RETRY_MS);
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      /*
       * A person's own space is made when they first connect a browser to record with
       * (learning/personal-space.ts, docs/automatic-learning.md), so somebody who never has has none,
       * and that is how it is meant to be rather than a fault. Said once, as information; looked
       * for again on the same minute's rhythm, so a space made later is picked up.
       */
      if (own && code === "CONTAINER_NOT_FOUND") {
        if (!notMadeYet.has(containerId)) {
          notMadeYet.add(containerId);
          console.info(
            JSON.stringify({
              type: "learning-personal-space-not-made",
              containerId,
              note: "This person has no Learning space of their own yet. It is made when they connect a browser to record with; until then their runs go on without it.",
            }),
          );
        }
        return undefined;
      }
      if ((warned.get(containerId) ?? 0) <= now()) {
        warned.set(containerId, now() + PERSONAL_RETRY_MS);
        console.warn(
          JSON.stringify({
            type: "learning-personal-skills-unavailable",
            containerId,
            code,
          }),
        );
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  /** The run's person's own Skills and everyone else's opened ones, each fetched at once and each failing soft. */
  const personalSnapshots = async (
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ own?: VerifiedSnapshot; opened: OpenedSkills[] }> => {
    if (!people) return { opened: [] };
    let sources: readonly OpenSkillSource[] = [];
    try {
      if (await people.sharingAllowed()) sources = await people.openSkills();
    } catch {
      console.warn(JSON.stringify({ type: "learning-open-skills-unread" }));
    }
    const others = sources.filter((source) => source.userId !== userId);
    // Read alongside the spaces rather than before them, so it adds no wait of its own.
    const withheldRead = (async (): Promise<
      ReadonlyMap<string, ReadonlySet<string>> | undefined
    > => {
      if (others.length === 0) return new Map();
      try {
        return await people.withheld(others.map((source) => source.userId));
      } catch {
        console.warn(JSON.stringify({ type: "learning-withheld-unread" }));
        return undefined;
      }
    })();
    const [withheld, own, ...opened] = await Promise.all([
      withheldRead,
      softSnapshot(people.containerFor(userId), signal, true),
      ...others.map((source) => softSnapshot(source.containerId, signal)),
    ]);
    // FAILS SAFE: with no word on what each person kept to themselves, nothing of anyone else's reaches this run.
    if (!withheld) return own ? { own, opened: [] } : { opened: [] };
    return {
      ...(own ? { own } : {}),
      opened: others.flatMap((source, index) => {
        const snapshot = opened[index];
        return snapshot
          ? [
              {
                source,
                withheld: withheld.get(source.userId) ?? new Set<string>(),
                snapshot,
              },
            ]
          : [];
      }),
    };
  };

  const acquire: AcquireLearnedSkills = async (agentId, signal, userId) => {
    signal?.throwIfAborted();
    const settings = await settingsForRun("acquire");
    signal?.throwIfAborted();
    // Unreadable: the run goes ahead without learned Skills. See `settingsForRun`.
    if (!settings) return undefined;
    // Learning off, or this Bot excluded by an administrator: no learned Skills of any kind.
    if (!settings.enabled || excludedFromLearning(settings, agentId)) {
      return undefined;
    }
    const target = selectLearningTarget(settings, agentId);
    const personal =
      userId && people
        ? personalSnapshots(userId, signal)
        : Promise.resolve({ opened: [] as OpenedSkills[] });
    if (!target && !(userId && people)) return undefined;
    // The Bot's own read fails the run exactly as it did before; the personal reads never throw.
    const [bot, extra] = await Promise.all([
      target
        ? waitForSnapshot(registryFor(target).acquireSnapshot(), signal)
        : undefined,
      personal,
    ]);
    signal?.throwIfAborted();
    const snapshot = mergeLearnedSkills({ bot, ...extra });
    // A Bot with no space of its own and nothing from anyone runs exactly as one with no Learning does.
    if (!snapshot || (!target && snapshot.skills.length === 0)) {
      return undefined;
    }
    return {
      catalog: snapshot.skills.length > 0 ? formatSkillCatalog(snapshot) : "",
      tools: snapshot.skills.length > 0 ? skillTools : [],
      execute: async (name, args) => {
        if (name === "copilotkit_load_skill") {
          return loadSkill(snapshot, skillArgs.parse(args).skill_name);
        }
        if (name === "copilotkit_read_skill_file") {
          const parsed = fileArgs.parse(args);
          return readSkillFile(snapshot, parsed.skill_name, parsed.path);
        }
        throw new Error("That is not a learned Skill tool.");
      },
    };
  };

  /**
   * The Skills published in any one Learning space, with their files (SKILL.md first), read the way a run reads them
   * (the same registry and Intelligence call). `off` when Automatic Learning is off here; `unavailable` when
   * Intelligence did not deliver them (its Learning delivery off, the space not made yet, or not reachable).
   */
  const containerSkills = async (
    containerId: string,
  ): Promise<
    { skills: LearnedSkillContent[] } | { unavailable: "off" | "unavailable" }
  > => {
    if (!(await store.read()).enabled) return { unavailable: "off" };
    try {
      const snapshot = await waitForSnapshot(
        registryFor({ containerId }).acquireSnapshot(),
        AbortSignal.timeout(PERSONAL_READ_MS),
      );
      return {
        skills: snapshot.skills.map(({ name, description, files }) => ({
          name,
          description,
          files: skillMdFirst(files),
        })),
      };
    } catch (error) {
      // The space exists and nothing is published in it yet.
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "REVISION_NOT_FOUND"
      )
        return { skills: [] };
      return { unavailable: "unavailable" };
    }
  };

  return {
    acquire,
    containerSkills,
    /** The Skills published in this person's own Learning space, for Settings, Learning. */
    async personalSkills(
      userId: string,
    ): Promise<
      | { skills: { name: string; description: string }[] }
      | { unavailable: "off" | "unavailable" }
    > {
      if (!people) return { unavailable: "unavailable" };
      const result = await containerSkills(people.containerFor(userId));
      if ("unavailable" in result) return result;
      return {
        skills: result.skills.map(({ name, description }) => ({
          name,
          description,
        })),
      };
    },
    /**
     * Bind once, before thread creation. The SDK calls this selector before its ownership check,
     * so the verified user scopes the durable decision. Existing Threads are never backfilled.
     */
    async containerForThread(
      input: LearningThread,
    ): Promise<string | undefined> {
      if (!input.userId.trim())
        throw new Error("Learning Thread assignment requires a verified user.");
      const settings = await settingsForRun("containerForThread");
      // Unreadable: the thread is not bound to Learning, and the run goes ahead. See `settingsForRun`.
      if (!settings) return undefined;
      const target = selectLearningTarget(settings, input.agentId);
      if (!target) return undefined;
      let exists = false;
      try {
        await client.getThread({
          threadId: input.threadId,
          userId: input.userId,
        });
        exists = true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            error.name === "PlatformRequestError" &&
            "status" in error &&
            error.status === 404
          )
        )
          throw error;
      }
      const containerId = await store.bindThread({
        userId: input.userId,
        threadId: input.threadId,
        agentId: input.agentId,
        containerId: exists ? null : (target?.containerId ?? null),
      });
      /*
       * A thread bound to a container this Intelligence was found not to have was never created:
       * creating it is what that container made fail. It is still new, so it takes today's target
       * rather than failing again every time the person sends to it.
       */
      if (!exists && containerId && options.forgotten?.(containerId))
        return target.containerId;
      return containerId ?? undefined;
    },
    async status(agentId: string): Promise<LearningDeliveryStatus> {
      const target = selectLearningTarget(await store.read(), agentId);
      if (!target)
        return { configured: false, initialized: false, stale: false };
      const status = registries.get(registryKey(target))?.status;
      return {
        configured: true,
        containerId: target.containerId,
        initialized: status?.initialized ?? false,
        stale: status?.stale ?? false,
        ...(status?.revision ? { revision: status.revision } : {}),
        ...(status?.lastCheckedAt
          ? { lastCheckedAt: status.lastCheckedAt }
          : {}),
        ...(status?.lastError ? { error: status.lastError } : {}),
      };
    },
  };
}
export type LearningRuntime = ReturnType<typeof createLearningRuntime>;
