import { createHash } from "node:crypto";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { learningPersonSpaces } from "../db/schema/learning";
import type { LearningContainerSpec } from "./ensure-container";

/**
 * A person's own Learning space: one Intelligence Learning container per OpenBot person, which every recording they make
 * joins, whichever Bot they later use, and whose published Skills reach every Bot they run (learning/runtime.ts).
 *
 * Its id is derived from the person's: `user-` and the first 32 hex digits of the SHA-256 of their OpenBot user id. A
 * user id is any text (mixed case, a better-auth id, `dev-local-user`), and Intelligence takes 1 to 64 lowercase letters,
 * digits and single hyphens, so the id is hashed rather than copied: the same person always gets the same space, on
 * every replica, with nothing to look up, and two people never share one.
 */
export function personalLearningContainerId(userId: string): string {
  return `user-${personDigest(userId)}`;
}

/** The first 32 hex digits of the SHA-256 of an OpenBot user id: what every id derived from a person is built on (their
 * Learning space here, and their OpenBot browser, browser/person.ts). */
export function personDigest(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

/** One branch per LearnedSkillsError code (or success): the existence question only. */
export function classifyLearningSpaceProbe(
  outcome: "ok" | { code: string },
): "assigned" | "missing" | "learning-off" | "unverified" {
  if (outcome === "ok") return "assigned";
  switch (outcome.code) {
    // The container exists; nothing is published yet, or delivery is paused.
    case "REVISION_NOT_FOUND":
    case "DELIVERY_DISABLED":
    case "REVISION_REVOKED":
      return "assigned";
    case "CONTAINER_NOT_FOUND":
      return "missing";
    // Intelligence's Learning delivery is unlicensed, refused or off (or does not serve the route): existence cannot
    // be checked.
    case "ENTITLEMENT_REQUIRED":
    case "AUTHORIZATION_FAILED":
    case "UNSUPPORTED_SERVER":
      return "learning-off";
    default:
      return "unverified";
  }
}

function errorCode(error: unknown): string {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === "string" ? code : "";
}

/** The rows that remember which people's spaces OpenBot has seen exist. */
export function createPersonSpaceStore(database: Database) {
  return {
    async confirmed(userId: string): Promise<boolean> {
      const [row] = await database
        .select({ userId: learningPersonSpaces.userId })
        .from(learningPersonSpaces)
        .where(eq(learningPersonSpaces.userId, userId))
        .limit(1);
      return row !== undefined;
    },
    /** Idempotent, so replicas confirming the same space at once all succeed. */
    async confirm(userId: string, containerId: string): Promise<void> {
      await database
        .insert(learningPersonSpaces)
        .values({ userId, containerId })
        .onConflictDoNothing();
    },
    async forget(userId: string): Promise<void> {
      await database
        .delete(learningPersonSpaces)
        .where(eq(learningPersonSpaces.userId, userId));
    },
  };
}
export type PersonSpaceStore = ReturnType<typeof createPersonSpaceStore>;

export type PersonalLearningSpaces = {
  containerFor(userId: string): string;
  /**
   * Whether this person's recordings land in their space, and its container id when a capture pass should name it.
   * Creates the space when Intelligence says it is missing (or cannot say) and a credential here can, waiting for that
   * only until `signal` aborts; the creation itself goes on. Never throws.
   */
  state(userId: string, signal?: AbortSignal): Promise<LearningSpaceState>;
  /** Make sure the person's space exists, in the background. Never throws and never waits. */
  kick(userId: string): void;
};

/** A probe answer is kept this long per container, as the Bot spaces' check kept it. */
const CACHE_MS = 60_000;
/** After a failed creation, the next attempt for that person waits this long, so a refusing Intelligence (or its
 * per-caller rate limit) is not asked on every popup and every capture pass. */
const RETRY_MS = 60_000;

/** Resolves with the promise's value, or with `undefined` as soon as `signal` aborts. */
function until<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve) => {
    const aborted = () => resolve(undefined);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, () => resolve(undefined))
      .finally(() => {
        signal.removeEventListener("abort", aborted);
      });
  });
}

/**
 * Each person's own Learning space, created on first need.
 *
 * THE RUNTIME KEY CANNOT CREATE A CONTAINER (learning/ensure-container.ts): only a service token on a local evaluation
 * install, or a CopilotKit CLI login against managed Intelligence, can. `create` is whichever of those this deployment
 * holds, and absent when it holds neither; then a space that does not exist cannot be made here, and the person is told
 * so. A service token creates in one request, well inside the capture pass's deadline; the CLI takes longer than that,
 * which is why the space is also made when the browser connects (`kick`), so it is there before the first recording.
 *
 * Safe on many replicas without a lock: Intelligence's container id is unique per project, so a second creation of the
 * same space answers "already exists", which counts as present, and the row that remembers it is a conditional insert.
 * Within one replica, concurrent requests for one person share one creation.
 */
export function createPersonalLearningSpaces(deps: {
  readSettings: () => Promise<LearningSettings>;
  /** The runtime key's client, for the skills read that proves a container exists. */
  snapshots: Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot">;
  store: PersonSpaceStore;
  /** Creates a container with a credential that can; absent when this deployment holds none. */
  create?: (
    container: LearningContainerSpec,
  ) => Promise<"created" | "present" | "skipped">;
  /** The person's display name, for the container's name in Intelligence. */
  nameFor?: (userId: string) => Promise<string | null>;
  /** Default 3_000, so a check fits inside the runtime's 5 s selector deadline. */
  probeTimeoutMs?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}): PersonalLearningSpaces {
  const probeTimeoutMs = deps.probeTimeoutMs ?? 3_000;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const probes = new Map<
    string,
    { expiresAt: number; state: LearningSpaceState["state"] }
  >();
  const creating = new Map<string, Promise<boolean>>();
  const retryAt = new Map<string, number>();

  const probe = async (
    containerId: string,
    signal?: AbortSignal,
    cached = true,
  ): Promise<ReturnType<typeof classifyLearningSpaceProbe>> => {
    const kept = probes.get(containerId);
    if (cached && kept && kept.expiresAt > now()) {
      return kept.state as ReturnType<typeof classifyLearningSpaceProbe>;
    }
    let state: ReturnType<typeof classifyLearningSpaceProbe>;
    try {
      await deps.snapshots.getLearnedSkillsSnapshot({
        containerId,
        signal: AbortSignal.any([
          signal ?? new AbortController().signal,
          AbortSignal.timeout(probeTimeoutMs),
        ]),
      });
      state = classifyLearningSpaceProbe("ok");
    } catch (error) {
      state = classifyLearningSpaceProbe({ code: errorCode(error) });
    }
    // An unverified answer is not kept: Intelligence coming back should be seen at once.
    if (state !== "unverified") {
      probes.set(containerId, { expiresAt: now() + CACHE_MS, state });
    }
    return state;
  };

  /** True once the space exists (made here, or already there). One attempt per person at a time on this replica. */
  const create = (userId: string, containerId: string): Promise<boolean> => {
    const running = creating.get(userId);
    if (running) return running;
    const create = deps.create;
    if (!create || (retryAt.get(userId) ?? 0) > now()) {
      return Promise.resolve(false);
    }
    const attempt = (async () => {
      try {
        const name = (await deps.nameFor?.(userId).catch(() => null))?.trim();
        const result = await create({
          id: containerId,
          name: `OpenBot: ${name || containerId}`.slice(0, 255),
        });
        if (result === "skipped") return false;
        // A key that can answer and still cannot see it means the credential made it in another project.
        if ((await probe(containerId, undefined, false)) === "missing") {
          throw new Error(
            "The credential created the space, but this runtime key cannot see it, so it is in another Intelligence project.",
          );
        }
        await deps.store.confirm(userId, containerId);
        probes.set(containerId, {
          expiresAt: now() + CACHE_MS,
          state: "assigned",
        });
        retryAt.delete(userId);
        log({
          type: "learning-personal-space",
          outcome: result,
          containerId,
        });
        return true;
      } catch (error) {
        retryAt.set(userId, now() + RETRY_MS);
        log({
          type: "learning-personal-space",
          outcome: "create_failed",
          containerId,
          // A credential's error can name an account; only its own sentence is kept, and briefly.
          message:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "The space could not be created.",
        });
        return false;
      }
    })().finally(() => {
      creating.delete(userId);
    });
    creating.set(userId, attempt);
    return attempt;
  };

  const confirmed = (userId: string) =>
    deps.store.confirmed(userId).catch(() => false);

  const state: PersonalLearningSpaces["state"] = async (userId, signal) => {
    let settings: LearningSettings;
    try {
      settings = await deps.readSettings();
    } catch {
      return { state: "unverified", containerId: null };
    }
    // Automatic Learning switched off in Admin: no space, and nothing is created.
    if (!settings.enabled) return { state: "unassigned", containerId: null };
    const containerId = personalLearningContainerId(userId);
    try {
      const found = await probe(containerId, signal);
      if (found === "assigned") {
        void deps.store.confirm(userId, containerId).catch(() => {});
        return { state: "assigned", containerId };
      }
      if (found === "missing") {
        // Removed in Intelligence, or never made: forget it, and make it again if a credential here can.
        await deps.store.forget(userId).catch(() => {});
        const made = await until(create(userId, containerId), signal);
        if (made) return { state: "assigned", containerId };
        // Still being made when the caller stopped waiting: not there yet, but not refused either.
        return made === undefined && creating.has(userId)
          ? { state: "unverified", containerId: null }
          : { state: "missing", containerId: null };
      }
      // Intelligence could not say. A space seen before, or made now, is named; so is one nobody here can check or make,
      // because the runtime joins without it when it turns out to be absent, so naming it never costs a recording.
      if (await confirmed(userId)) return { state: found, containerId };
      if (await until(create(userId, containerId), signal)) {
        return { state: "assigned", containerId };
      }
      return { state: found, containerId };
    } catch {
      return { state: "unverified", containerId: null };
    }
  };

  return {
    containerFor: personalLearningContainerId,
    state,
    kick(userId) {
      void state(userId).catch(() => {});
    },
  };
}
