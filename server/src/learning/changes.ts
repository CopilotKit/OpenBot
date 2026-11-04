/**
 * Intelligence's `learning_changes` announcements, for every Learning cache on this instance: the Learning settings
 * (learning/settings.ts), the open-Skill index (learning/sharing.ts) and the spaces seen to exist
 * (learning/personal-space.ts). One subscription per process, shared by all of them.
 *
 * An announcement says what changed and its version, never what it now holds; each cache reads it again. Delivery is
 * at most once, so every cache also reads everything again whenever the subscription joins (the first time and after
 * every reconnect) and on a timer of its own.
 */
import {
  type ProjectChange,
  type ProjectChangeSubscription,
  type ProjectChangesClient,
  subscribeToProjectChanges,
} from "../intelligence/project-changes";

/** One `learning_changes` announcement, as the contract states it. */
export type LearningChange =
  | { entity: "agent_assignments"; version: number }
  | { entity: "personal_space"; appUserId: string; version: number };

export type LearningChangeListener = {
  onChange(change: LearningChange): void;
  /** The subscription joined: anything announced while it was down was missed. */
  onJoined(): void;
};

export type LearningChanges = {
  /** Add a listener; returns its removal. */
  listen(listener: LearningChangeListener): () => void;
  start(): void;
  stop(): void;
  /** Whether announcements are arriving: the subscription is joined. */
  subscribed(): boolean;
};

/** The family's fields, or null for anything this OpenBot does not know. */
export function parseLearningChange(
  change: Record<string, unknown>,
): LearningChange | null {
  const { entity, version, appUserId } = change;
  if (typeof version !== "number" || !Number.isInteger(version)) return null;
  if (entity === "agent_assignments") return { entity, version };
  if (entity === "personal_space" && typeof appUserId === "string")
    return { entity, appUserId, version };
  return null;
}

export function createLearningChanges(options: {
  client: Pick<ProjectChangesClient, "subscribe" | "joinCode">;
  gatewayWsUrl: string;
  /** How announcements are subscribed to. The gateway's, unless a test drives them itself. */
  subscribe?: typeof subscribeToProjectChanges;
}): LearningChanges {
  const listeners = new Set<LearningChangeListener>();
  let subscription: ProjectChangeSubscription | undefined;
  const each = (call: (listener: LearningChangeListener) => void) => {
    for (const listener of listeners) {
      try {
        call(listener);
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "learning-change-listener-failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };
  return {
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (subscription) return;
      subscription = (options.subscribe ?? subscribeToProjectChanges)({
        resource: "learning_changes",
        client: options.client,
        gatewayWsUrl: options.gatewayWsUrl,
        onChange: (change: ProjectChange) => {
          const parsed = parseLearningChange(change);
          if (parsed) each((listener) => listener.onChange(parsed));
        },
        onJoined: () => each((listener) => listener.onJoined()),
      });
    },
    stop() {
      subscription?.stop();
      subscription = undefined;
    },
    subscribed: () => subscription?.joinCode() != null,
  };
}
