import type { LearningSharingMode } from "@openbot/shared/learning";
import type { LearningChanges } from "./changes";
import {
  type LearningIntelligence,
  LearningVersionConflictError,
  type PersonalSpace,
} from "./intelligence";
import { personalLearningContainerId } from "./personal-space";

/**
 * One person's Skills that every Bot in the deployment may use: all of them (`open`), or the ones they opened by name
 * (`choose`). A person whose choice is `closed`, or `choose` with nothing opened, has no entry.
 */
export type OpenSkillSource = {
  userId: string;
  containerId: string;
  skills: "all" | ReadonlySet<string>;
};

/** What a person's space says they opened, as the index keeps it; undefined when they opened nothing. */
export function openSkillSource(
  space: PersonalSpace,
): OpenSkillSource | undefined {
  const containerId = personalLearningContainerId(space.appUserId);
  if (space.sharing.mode === "open")
    return { userId: space.appUserId, containerId, skills: "all" };
  if (space.sharing.mode === "choose" && space.sharing.openSkills.length > 0)
    return {
      userId: space.appUserId,
      containerId,
      skills: new Set(space.sharing.openSkills),
    };
  return undefined;
}

/** A save that keeps meeting newer versions gives up after this many tries. */
const SAVE_ATTEMPTS = 5;

/**
 * The sharing choice a person made for the Skills in their own Learning space, kept in Intelligence with the space
 * (learning/intelligence.ts). Every change reads the space, changes it and saves it under the version it read; a
 * change that meets a newer version reads again and redoes it, so two changes at once are taken in turn and each
 * says truly what it changed. `onSaved` hears every saved space, so this instance's open-Skill index has it at once.
 */
export function createLearningSharingStore(
  intelligence: Pick<
    LearningIntelligence,
    "personalSpace" | "saveSharing" | "personalSpaces"
  >,
  options: { onSaved?: (space: PersonalSpace) => void } = {},
) {
  /** Read, change and save under the version read, again from the start when somebody saved first. */
  const change = async <T>(
    userId: string,
    decide: (space: PersonalSpace) =>
      | {
          save: { mode: LearningSharingMode; openSkills?: string[] };
          result: T;
        }
      | { result: T },
  ): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const space = await intelligence.personalSpace(userId);
      const decision = decide(space);
      if (!("save" in decision)) return decision.result;
      try {
        const saved = await intelligence.saveSharing(
          userId,
          decision.save,
          space.version,
        );
        options.onSaved?.(saved);
        return decision.result;
      } catch (error) {
        if (
          !(error instanceof LearningVersionConflictError) ||
          attempt >= SAVE_ATTEMPTS
        )
          throw error;
      }
    }
  };

  return {
    /** Their choice (`closed` when they never made one) and every Skill they opened under `choose`. */
    async read(
      userId: string,
    ): Promise<{ mode: LearningSharingMode; openSkills: string[] }> {
      const { sharing } = await intelligence.personalSpace(userId);
      return { mode: sharing.mode, openSkills: [...sharing.openSkills] };
    },

    /** Saves the choice and says what it was before. Two saves at once are taken in turn, so each `from` is true. */
    setMode(
      userId: string,
      mode: LearningSharingMode,
    ): Promise<{ from: LearningSharingMode; to: LearningSharingMode }> {
      return change(userId, (space) => ({
        // The Skills opened under `choose` stay as they are, so choosing again opens the same ones.
        save: { mode },
        result: { from: space.sharing.mode, to: mode },
      }));
    },

    /** Opens or closes one Skill by name. True when that changed anything. */
    setSkillOpen(
      userId: string,
      skillName: string,
      open: boolean,
    ): Promise<boolean> {
      return change(userId, (space) => {
        const opened = new Set(space.sharing.openSkills);
        if (opened.has(skillName) === open) return { result: false };
        if (open) opened.add(skillName);
        else opened.delete(skillName);
        return {
          save: { mode: space.sharing.mode, openSkills: [...opened] },
          result: true,
        };
      });
    },

    /** Everyone who opened something, and what. Read by the open-Skill index, never per run. */
    async openSources(): Promise<OpenSkillSource[]> {
      return (await intelligence.personalSpaces({ shared: true })).flatMap(
        (space) => {
          const source = openSkillSource(space);
          return source ? [source] : [];
        },
      );
    },
  };
}
export type LearningSharingStore = ReturnType<
  typeof createLearningSharingStore
>;

/** How often a replica reads the whole index again, in case an announcement was lost. */
const INDEX_REFRESH_MS = 30_000;

/**
 * What every person has opened, kept in memory so a run never asks Intelligence (let alone each person's space) who
 * shares what.
 *
 * A change made on this replica is in the index before the Settings route answers (`apply`, from the saved space).
 * Another replica's change arrives as a `learning_changes` announcement, and the person's space is read again. The
 * whole index is read again whenever the subscription joins and every 30 seconds (`start`), because announcements can
 * be lost; `invalidate` asks for that at once, in the background. Runs read the index as it stands and never wait on
 * Intelligence for it, except for the very first read on an instance, which waits for that first answer. A failed
 * read keeps the last index, or none.
 */
export function createOpenSkillIndex(deps: {
  /** Everyone who opened something (`LearningSharingStore.openSources`). */
  read: () => Promise<OpenSkillSource[]>;
  /** One person's space, read after an announcement about it. Without it, an announcement reads the whole index. */
  readOne?: (userId: string) => Promise<PersonalSpace>;
  refreshIntervalMs?: number;
}) {
  let current: Map<string, OpenSkillSource> | undefined;
  /** The version of each person's space this index holds, so an older answer never replaces a newer one. */
  const versions = new Map<string, number>();
  let reading: Promise<void> | undefined;
  /** Another full read was asked for while one was running. */
  let again = false;
  /** Bumped by every change applied, so a full read that began before one cannot overwrite it. */
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => void) | undefined;

  const refresh = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          const started = generation;
          const sources = await deps.read();
          // Something changed while this read ran: what it read may be older than that, so read again.
          if (started !== generation && current) {
            again = true;
            continue;
          }
          current = new Map(sources.map((source) => [source.userId, source]));
        } while (again);
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };
  const quietly = (work: Promise<unknown>, reason: string) => {
    work.catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "learning-open-skills-refresh-failed",
          reason,
          note: "Runs keep the open Skills this instance last read.",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  };
  const apply = (space: PersonalSpace) => {
    const held = versions.get(space.appUserId);
    if (held !== undefined && space.version !== 0 && held > space.version)
      return;
    generation++;
    versions.set(space.appUserId, space.version);
    if (!current) return;
    const source = openSkillSource(space);
    if (source) current.set(space.appUserId, source);
    else current.delete(space.appUserId);
  };

  return {
    async sources(): Promise<OpenSkillSource[]> {
      if (!current) await refresh();
      return [...(current?.values() ?? [])];
    },
    /** A space this replica just saved, or just read after an announcement. */
    apply,
    /** Read everything again now. */
    refresh,
    /** Read everything again soon, without anyone waiting for it. */
    invalidate() {
      generation++;
      quietly(refresh(), "invalidated");
    },
    /** Keep the index fresh from `changes` and a timer. */
    start(changes?: LearningChanges) {
      unlisten = changes?.listen({
        onChange: (change) => {
          if (change.entity !== "personal_space") return;
          const held = versions.get(change.appUserId);
          if (
            held !== undefined &&
            change.version !== 0 &&
            held >= change.version
          )
            return;
          if (!deps.readOne) {
            generation++;
            quietly(refresh(), "announced");
            return;
          }
          quietly(deps.readOne(change.appUserId).then(apply), "announced");
        },
        onJoined: () => {
          generation++;
          quietly(refresh(), "joined");
        },
      });
      quietly(refresh(), "started");
      timer = setInterval(
        () => quietly(refresh(), "timer"),
        deps.refreshIntervalMs ?? INDEX_REFRESH_MS,
      );
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      unlisten?.();
      unlisten = undefined;
    },
  };
}
export type OpenSkillIndex = ReturnType<typeof createOpenSkillIndex>;
