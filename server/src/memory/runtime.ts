import { type Edition, editionHasMemory } from "../edition";
import type { MemoryDefaults } from "./defaults";
import type { MemoryIngestion } from "./ingestion";
import type { MemoryStore } from "./store";
import type { LoadPersonalMemory } from "./tools";

/**
 * What of memory runs while OpenBot runs: what a Bot's turn is told it remembers, and the sweep that
 * reads memory sources and mirrors memories to Intelligence.
 *
 * NOTHING IN AN EDITION WITHOUT MEMORY (`editionHasMemory`). No loader, so no turn picks up memory
 * sources or carries memory in its context, and a sweep that reads nothing, so a source left from
 * before is never synced.
 */
export function createMemoryRuntime(options: {
  edition: Edition;
  defaults: Pick<MemoryDefaults, "botTurn">;
  ingestion: Pick<MemoryIngestion, "contextFor" | "syncDue">;
  store: Pick<MemoryStore, "mirrorPending">;
  log?: (line: string) => void;
}): {
  /** For the agent resolver. Absent without memory, and then no turn gets the memory middleware. */
  loadForActor?: (ownerUserId: string) => LoadPersonalMemory;
  /** One pass of the background sweep. */
  sweep(): Promise<void>;
} {
  if (!editionHasMemory(options.edition)) return { sweep: async () => {} };
  const log = options.log ?? ((line: string) => console.error(line));
  const attempt = async (operation: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      log(
        JSON.stringify({
          type: "memory-sweep-error",
          error: error instanceof Error ? error.name : "UnknownError",
          context: { operation },
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };
  return {
    loadForActor: (ownerUserId) => (botId) => {
      // Apps connected since this Bot's last turn become its memory sources. Never waits.
      options.defaults.botTurn(ownerUserId, botId);
      return options.ingestion.contextFor(ownerUserId, botId);
    },
    async sweep() {
      await attempt("syncDue", () => options.ingestion.syncDue());
      // Mirror to Intelligence what is out of step: the backfill on the first passes after a
      // deployment becomes entitled, and afterwards whatever an outage left behind. A no-op without
      // Intelligence.
      await attempt("mirrorPending", () => options.store.mirrorPending());
    },
  };
}
