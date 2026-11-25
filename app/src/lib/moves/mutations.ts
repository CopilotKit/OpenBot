import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { Import } from "@/lib/api/generated/model";
import {
  applyImport,
  createImport,
  getImport,
  getImportVerification,
} from "@/lib/api/generated/moving-to-openbot-cloud/moving-to-openbot-cloud";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

const FALLBACK = "Couldn't move your Bots. Try again.";
const UNCHECKED = "Not everything arrived here. Try again.";

/** How often a move is read while OpenBot Cloud carries it out. */
const READ_EVERY_MS = 1_000;

/**
 * A move that started and then stopped, in the server's sentence. It carries the import, so trying
 * again goes on with that one: applying a failed import goes on from where it stopped.
 */
export class MoveStopped extends Error {
  readonly importId: string;
  constructor(message: string, importId: string) {
    super(message);
    this.name = "MoveStopped";
    this.importId = importId;
  }
}

/** What moving the person's Bots here needs. */
export type MoveHereInput = {
  /** The organization the Bots are in now. */
  fromOrganizationId: string;
  /** The move to go on with, when trying again after one stopped (`MoveStopped`). */
  importId?: string;
};

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Read the move until OpenBot Cloud says it is imported or failed. A status not known reads as importing. */
async function untilFinished(here: string, move: Import): Promise<Import> {
  let now = move;
  while (now.status !== "imported" && now.status !== "failed") {
    await wait(READ_EVERY_MS);
    now = await getImport(here, move.id, { fallback: FALLBACK });
  }
  return now;
}

/**
 * Move the person's own Bots, with everything that is theirs, from another of their organizations
 * into the one they work in (createImport with fromOrganizationId). OpenBot Cloud packs them up
 * there, brings them in here, checks them, and only then removes them from there. Done only once
 * the check here says everything arrived.
 *
 * A refusal is the server's own sentence: an organization that doesn't let them use Bots answers
 * MOVE_NOT_ALLOWED before anything moves. A move that stops says why in `MoveStopped`.
 *
 * Bots, conversations, routines, skills and the moves themselves all changed, so everything is read
 * again.
 */
export function moveHereMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async ({
      fromOrganizationId,
      importId,
    }: MoveHereInput): Promise<Import> => {
      const here = organizationId();
      const started = importId
        ? { id: importId }
        : await createImport(
            here,
            { "Idempotency-Key": idempotencyKey() },
            { fromOrganizationId },
            { fallback: FALLBACK },
          );
      try {
        const applied = await applyImport(
          here,
          started.id,
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        );
        const done = await untilFinished(here, applied);
        if (done.status === "failed")
          throw new MoveStopped(done.error ?? FALLBACK, done.id);
        const check = await getImportVerification(here, done.id, {
          fallback: FALLBACK,
        });
        if (!check.matches) throw new MoveStopped(UNCHECKED, done.id);
        return done;
      } catch (error) {
        if (error instanceof MoveStopped) throw error;
        // A move that isn't there any more is started afresh on trying again.
        if (error instanceof ClientError && error.code === "IMPORT_NOT_FOUND")
          throw error;
        // Once it has started, trying again goes on with this move, whatever stopped it.
        throw new MoveStopped(
          error instanceof Error ? error.message : FALLBACK,
          started.id,
        );
      }
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
