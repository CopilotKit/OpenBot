/**
 * Intelligence's Learning assignments, as OpenBot calls them: which Learning container each Bot and each thread uses,
 * each person's own Learning space and their sharing choice, and which person a Recorder trajectory belongs to. All of
 * it lives in Intelligence, under this deployment's project key; the contract is Intelligence's
 * `docs/contracts/learning-assignments.md`. OpenBot's own tables for these (`learning_settings`,
 * `learning_thread_bindings`, `learning_person_spaces`, `learning_skill_sharing`, `learning_open_skills`,
 * `recorder_trajectory_bindings`) are read only by the upgrade copy (learning/upgrade.ts).
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops, Intelligence
 * answers 5xx) is retried with the same key, so a retry after a lost response is the same write. Nothing here holds a
 * database connection: a caller must never call this with an OpenBot transaction open.
 */
import type {
  LearningSettings,
  LearningSharingMode,
  LearningTarget,
} from "@openbot/shared/learning";

export type LearningIntelligenceSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is its error code when it sent one. */
export class LearningIntelligenceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "LearningIntelligenceError";
  }
}

/** A save named a version that is no longer the current one: somebody saved first. Read again and redo it. */
export class LearningVersionConflictError extends LearningIntelligenceError {
  constructor(what: string) {
    super(
      `${what} changed since it was read.`,
      412,
      "LEARNING_VERSION_CONFLICT",
    );
    this.name = "LearningVersionConflictError";
  }
}

/** A thread's container was decided from Learning settings that have changed since: read them again and decide again. */
export class LearningAssignmentsChangedError extends LearningIntelligenceError {
  constructor() {
    super(
      "The Learning settings changed since this thread's container was decided.",
      412,
      "LEARNING_ASSIGNMENTS_CHANGED",
    );
    this.name = "LearningAssignmentsChangedError";
  }
}

/** The project's Learning settings as Intelligence holds them. `savedAt` null: nothing saved (version 0: never). */
export type AgentAssignments = {
  settings: LearningSettings;
  version: number;
  savedAt: string | null;
};

/** The container one person's thread was given on its first run (null: an explicit unassigned first run). */
export type ThreadAssignment = {
  threadId: string;
  appUserId: string;
  agentId: string;
  learningContainerId: string | null;
  assignmentsVersion: number | null;
  createdAt: string;
};

/** One person's own Learning space: the container seen to exist, and their sharing choice. Version 0: nothing saved. */
export type PersonalSpace = {
  appUserId: string;
  learningContainerId: string | null;
  confirmedAt: string | null;
  sharing: { mode: LearningSharingMode; openSkills: string[] };
  version: number;
  updatedAt: string | null;
};

export type LearningIntelligence = ReturnType<
  typeof createLearningIntelligence
>;

/** Per-call limits: how long one attempt may take, and how many attempts. */
type CallLimits = { timeoutMs?: number; attempts?: number };

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE = 500;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function learningIdempotencyKey(operation: string): string {
  return `openbot:learning:${operation}:${crypto.randomUUID()}`;
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function toSettings(wire: {
  enabled: boolean;
  defaultTarget: LearningTarget | null;
  agents: Record<string, LearningTarget | null>;
}): LearningSettings {
  return {
    enabled: wire.enabled,
    defaultTarget: wire.defaultTarget,
    agents: wire.agents,
  };
}

export function createLearningIntelligence(
  settings: LearningIntelligenceSettings,
) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
      limits?: CallLimits;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    // Version 0 is "nothing saved": If-None-Match: * says the same and every HTTP stack reads it alike.
    if (options.ifMatch !== undefined) {
      if (options.ifMatch === 0) headers["if-none-match"] = "*";
      else headers["if-match"] = `"${options.ifMatch}"`;
    }
    const attempts = options.limits?.attempts ?? ATTEMPTS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(
            options.limits?.timeoutMs ?? REQUEST_TIMEOUT_MS,
          ),
        });
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to send again, and a
        // read is safe to repeat.
        if (response.status >= 500 && attempt < attempts) {
          lastError = new LearningIntelligenceError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await pause(attempt);
      }
    }
    if (lastError instanceof LearningIntelligenceError) throw lastError;
    throw new LearningIntelligenceError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refused(
    response: Response,
    action: string,
  ): Promise<LearningIntelligenceError> {
    const code = await errorCode(response);
    return new LearningIntelligenceError(
      `Intelligence refused to ${action}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  const spacePath = (appUserId: string) =>
    `/api/v1/learning/personal-spaces/${encodeURIComponent(appUserId)}`;
  const trajectoryPath = (trajectoryId: string) =>
    `/api/trajectories/${encodeURIComponent(trajectoryId)}/app-user`;

  const client = {
    /** The project's Learning settings, as saved (or what nothing saved reads as). */
    async agentAssignments(limits?: CallLimits): Promise<AgentAssignments> {
      const response = await request(
        "GET",
        "/api/v1/learning/agent-assignments",
        { ...(limits ? { limits } : {}) },
      );
      if (!response.ok)
        throw await refused(response, "read the Learning settings");
      const wire = (await response.json()) as Parameters<
        typeof toSettings
      >[0] & { version: number; savedAt: string | null };
      return {
        settings: toSettings(wire),
        version: wire.version,
        savedAt: wire.savedAt,
      };
    },

    /**
     * Save the Learning settings whole, replacing `expectedVersion` (0: only while nothing is saved).
     * @throws LearningVersionConflictError when somebody saved first.
     */
    async saveAgentAssignments(
      next: LearningSettings,
      expectedVersion: number,
      key = learningIdempotencyKey("settings"),
    ): Promise<AgentAssignments> {
      const response = await request(
        "PUT",
        "/api/v1/learning/agent-assignments",
        { body: next, ifMatch: expectedVersion, idempotencyKey: key },
      );
      if (response.status === 412)
        throw new LearningVersionConflictError("The Learning settings");
      if (!response.ok)
        throw await refused(response, "save the Learning settings");
      const wire = (await response.json()) as Parameters<
        typeof toSettings
      >[0] & { version: number; savedAt: string | null };
      return {
        settings: toSettings(wire),
        version: wire.version,
        savedAt: wire.savedAt,
      };
    },

    /** Forget the saved Learning settings: they read as nothing saved again. */
    async purgeAgentAssignments(
      key = learningIdempotencyKey("settings-purge"),
    ): Promise<void> {
      const response = await request(
        "DELETE",
        "/api/v1/learning/agent-assignments",
        { idempotencyKey: key },
      );
      if (!response.ok)
        throw await refused(response, "purge the Learning settings");
    },

    /**
     * Give a person's thread its container, first write wins: the answer is always the winner's, null included.
     * @throws LearningAssignmentsChangedError when this would create it from stale settings (`assignmentsVersion`).
     */
    async assignThread(
      input: {
        threadId: string;
        appUserId: string;
        agentId: string;
        learningContainerId: string | null;
        assignmentsVersion?: number;
        /** When it was first decided, for an upgrade copying the assignments it already made. */
        createdAt?: Date;
      },
      key = learningIdempotencyKey("thread"),
    ): Promise<ThreadAssignment> {
      const response = await request(
        "POST",
        "/api/v1/learning/thread-assignments",
        {
          body: {
            ...input,
            ...(input.createdAt
              ? { createdAt: input.createdAt.toISOString() }
              : {}),
          },
          idempotencyKey: key,
        },
      );
      if (
        response.status === 412 &&
        (await errorCode(response)) === "LEARNING_ASSIGNMENTS_CHANGED"
      )
        throw new LearningAssignmentsChangedError();
      if (!response.ok)
        throw await refused(response, "assign the thread's Learning container");
      return (await response.json()) as ThreadAssignment;
    },

    /** Every thread assignment, of one person or of everyone, walking the listing to its end. */
    async threadAssignments(appUserId?: string): Promise<ThreadAssignment[]> {
      const all: ThreadAssignment[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: String(PAGE) });
        if (appUserId !== undefined) query.set("appUserId", appUserId);
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/v1/learning/thread-assignments?${query}`,
        );
        if (!response.ok)
          throw await refused(response, "list the thread assignments");
        const page = (await response.json()) as {
          threadAssignments: ThreadAssignment[];
          nextCursor: string | null;
        };
        all.push(...page.threadAssignments);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    },

    /** Remove every thread assignment of one person, when they are removed. */
    async deleteThreadAssignments(
      appUserId: string,
      key = learningIdempotencyKey("threads-delete"),
    ): Promise<number> {
      const response = await request(
        "DELETE",
        `/api/v1/learning/thread-assignments?${new URLSearchParams({ appUserId })}`,
        { idempotencyKey: key },
      );
      if (!response.ok)
        throw await refused(response, "remove the person's thread assignments");
      return ((await response.json()) as { deleted: number }).deleted;
    },

    /** One person's space, or what nothing saved reads as (version 0). */
    async personalSpace(
      appUserId: string,
      limits?: CallLimits,
    ): Promise<PersonalSpace> {
      const response = await request("GET", spacePath(appUserId), {
        ...(limits ? { limits } : {}),
      });
      if (!response.ok)
        throw await refused(response, "read the person's Learning space");
      return (await response.json()) as PersonalSpace;
    },

    /** Record that the person's space exists. Idempotent. `confirmedAt` keeps when it was first seen, on an upgrade. */
    async confirmPersonalSpace(
      appUserId: string,
      learningContainerId: string,
      options: { confirmedAt?: Date; key?: string } = {},
    ): Promise<PersonalSpace> {
      const response = await request(
        "POST",
        `${spacePath(appUserId)}/confirm`,
        {
          body: {
            learningContainerId,
            ...(options.confirmedAt
              ? { confirmedAt: options.confirmedAt.toISOString() }
              : {}),
          },
          idempotencyKey: options.key ?? learningIdempotencyKey("confirm"),
        },
      );
      if (!response.ok)
        throw await refused(response, "confirm the person's Learning space");
      return (await response.json()) as PersonalSpace;
    },

    /** Forget that the person's space exists (it was found missing). Their sharing choice stays. */
    async forgetPersonalSpace(
      appUserId: string,
      key = learningIdempotencyKey("forget"),
    ): Promise<PersonalSpace> {
      const response = await request(
        "DELETE",
        `${spacePath(appUserId)}/confirm`,
        { idempotencyKey: key },
      );
      if (!response.ok)
        throw await refused(response, "forget the person's Learning space");
      return (await response.json()) as PersonalSpace;
    },

    /**
     * Save the person's sharing choice, replacing `expectedVersion` (0: only while nothing is saved for them). Without
     * `openSkills` the Skills they opened stay as they are.
     * @throws LearningVersionConflictError when the space changed since it was read.
     */
    async saveSharing(
      appUserId: string,
      sharing: { mode: LearningSharingMode; openSkills?: string[] },
      expectedVersion: number,
      key = learningIdempotencyKey("sharing"),
    ): Promise<PersonalSpace> {
      const response = await request("PUT", `${spacePath(appUserId)}/sharing`, {
        body: sharing,
        ifMatch: expectedVersion,
        idempotencyKey: key,
      });
      if (response.status === 412)
        throw new LearningVersionConflictError("The person's Learning space");
      if (!response.ok)
        throw await refused(response, "save the person's sharing choice");
      return (await response.json()) as PersonalSpace;
    },

    /** Remove the person's space record and sharing choice, when they are removed. The container stays in Learning. */
    async purgePersonalSpace(
      appUserId: string,
      key = learningIdempotencyKey("space-purge"),
    ): Promise<void> {
      const response = await request("DELETE", spacePath(appUserId), {
        idempotencyKey: key,
      });
      if (!response.ok)
        throw await refused(response, "remove the person's Learning space");
    },

    /** Every space, or only the shared ones (`shared: true`: mode not closed), walking the listing to its end. */
    async personalSpaces(
      options: { shared?: boolean } = {},
    ): Promise<PersonalSpace[]> {
      const all: PersonalSpace[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: String(PAGE) });
        if (options.shared !== undefined)
          query.set("shared", String(options.shared));
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/v1/learning/personal-spaces?${query}`,
        );
        if (!response.ok)
          throw await refused(response, "list the Learning spaces");
        const page = (await response.json()) as {
          personalSpaces: PersonalSpace[];
          nextCursor: string | null;
        };
        all.push(...page.personalSpaces);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    },

    /**
     * Bind a trajectory to this person, or find it already theirs. False when it belongs to somebody else.
     * `trajectoryId` must be a UUID.
     */
    async claimTrajectory(
      trajectoryId: string,
      appUserId: string,
      limits?: CallLimits,
    ): Promise<boolean> {
      const response = await request("PUT", trajectoryPath(trajectoryId), {
        body: { appUserId },
        ...(limits ? { limits } : {}),
      });
      if (response.status === 409) return false;
      if (!response.ok)
        throw await refused(response, "bind the Recorder trajectory");
      return true;
    },

    /** Whose trajectory this is, or null when Intelligence has none by that id. */
    async trajectoryOwner(
      trajectoryId: string,
      limits?: CallLimits,
    ): Promise<string | null> {
      const response = await request("GET", trajectoryPath(trajectoryId), {
        ...(limits ? { limits } : {}),
      });
      if (response.status === 404) return null;
      if (!response.ok)
        throw await refused(response, "read the Recorder trajectory's owner");
      return ((await response.json()) as { appUserId: string }).appUserId;
    },
  };
  return client;
}
