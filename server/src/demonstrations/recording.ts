import {
  type DemonstrationRoutineCreator,
  type DemonstrationScheduleInput,
  scheduleDemonstrationSkill,
} from "./schedule";
import type { DemonstrationStore } from "./store";
import {
  DEMONSTRATION_MAX_DURATION_MS,
  DemonstrationRefusedError,
} from "./types";
/** Only trusted computer output calls this; there is no public action-upload endpoint. */
export function createDemonstrationRecorder(options: {
  store: Pick<
    DemonstrationStore,
    "get" | "start" | "append" | "stop" | "markPublished"
  >;
  ownsBot: (ownerUserId: string, botId: string) => Promise<boolean>;
  ownsSkill: (ownerUserId: string, slug: string) => Promise<boolean>;
  /** The routine store's own create, so a scheduled skill is an ordinary routine. */
  routines?: DemonstrationRoutineCreator;
  /** Overridable for tests; production stops a recording at ten minutes. */
  maxDurationMs?: number;
}) {
  const pending = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const maxDurationMs = options.maxDurationMs ?? DEMONSTRATION_MAX_DURATION_MS;
  const clearTimer = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };
  async function stop(ownerUserId: string, id: string) {
    clearTimer(id);
    await pending.get(id);
    return options.store.stop(ownerUserId, id);
  }
  return {
    async start(ownerUserId: string, botId: string, title: string) {
      if (!(await options.ownsBot(ownerUserId, botId)))
        throw new DemonstrationRefusedError(
          "Choose one of your Bots to record a demonstration.",
        );
      const recording = await options.store.start(ownerUserId, botId, title);
      /*
       * The server stops the recording at its limit even if nobody is watching. The store also
       * expires overdue recordings on every read, so a restart or another replica cannot extend one.
       */
      const timer = setTimeout(() => {
        timers.delete(recording.id);
        stop(ownerUserId, recording.id).catch((error) => {
          console.error(
            JSON.stringify({
              type: "demonstration-time-limit-stop-failed",
              error: error instanceof Error ? error.name : "UnknownError",
              context: { recordingId: recording.id },
              timestamp: new Date().toISOString(),
            }),
          );
        });
      }, maxDurationMs);
      (timer as { unref?: () => void }).unref?.();
      timers.set(recording.id, timer);
      return recording;
    },
    async capture(
      ownerUserId: string,
      botId: string,
      recordingId: string,
      action: unknown,
    ) {
      // Stop waits for every successful gesture already received on the stream.
      const work = (pending.get(recordingId) ?? Promise.resolve()).then(
        async () => {
          const recording = await options.store.get(ownerUserId, recordingId);
          if (recording.botId !== botId)
            throw new DemonstrationRefusedError(
              "That action belongs to another Bot.",
            );
          await options.store.append(ownerUserId, recordingId, action);
        },
      );
      pending.set(recordingId, work);
      try {
        await work;
      } finally {
        if (pending.get(recordingId) === work) pending.delete(recordingId);
      }
    },
    stop,
    async markPublished(ownerUserId: string, id: string, slug: string) {
      if (!(await options.ownsSkill(ownerUserId, slug)))
        throw new DemonstrationRefusedError(
          "Save a skill you own before linking this demonstration.",
        );
      return options.store.markPublished(ownerUserId, id, slug);
    },
    /** Run the published skill on a schedule, through the routine store's ordinary create. */
    async schedule(
      ownerUserId: string,
      id: string,
      input: DemonstrationScheduleInput,
    ) {
      if (!options.routines)
        throw new DemonstrationRefusedError(
          "Routines are not available in this deployment.",
        );
      const recording = await options.store.get(ownerUserId, id);
      if (
        recording.status !== "published" ||
        !recording.skillSlug ||
        !(await options.ownsSkill(ownerUserId, recording.skillSlug))
      )
        throw new DemonstrationRefusedError(
          "Save this demonstration as a skill before scheduling it.",
        );
      return scheduleDemonstrationSkill(options.routines, {
        ownerUserId,
        botId: recording.botId,
        title: recording.title,
        slug: recording.skillSlug,
        input,
      });
    },
  };
}
export type DemonstrationRecorder = ReturnType<
  typeof createDemonstrationRecorder
>;
