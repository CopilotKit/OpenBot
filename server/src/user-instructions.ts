import { eq } from "drizzle-orm";
import type { Database } from "./db/client";
import { userInstructions } from "./db/schema";

/**
 * One person's standing instructions: the thing every coworker they run is told, in every channel.
 *
 * WHAT THIS IS FOR. Until now the only durable instruction carriers were per coworker or per task. A
 * role belongs to the coworker and reads the same to everybody who talks to it; a skill is pulled in
 * for one job and then gone. Neither can hold "we are two people, never call us a team" or "write in
 * British English", which is a fact about the person rather than about the work, and which somebody
 * otherwise retypes into every conversation until they stop bothering and simply accept worse
 * answers.
 *
 * WHAT IT IS NOT. It is not a grant and it changes nothing about what a coworker may call. It is
 * prose appended to a prompt, so the worst a bad one can do is make an answer worse — which is why
 * every failure to read it is silent at the seam that uses it, and why the cap below is generous
 * rather than careful.
 */
export type UserInstructionsStore = {
  /** Null when this person has written none. Never an empty string: see {@link INSTRUCTIONS_LIMIT}. */
  read: (userId: string) => Promise<string | null>;
  /**
   * Save, or clear. Returns what was stored, which is the trimmed text, or "" when the row is gone.
   *
   * Returned rather than assumed by the caller, because the trim is this module's decision and a
   * screen that echoed back what it sent would show trailing whitespace the database does not have.
   */
  write: (userId: string, text: string) => Promise<string>;
};

/**
 * How much one person may say, in characters.
 *
 * A ceiling on a prompt rather than a validation rule with a reason behind it: every built-in
 * coworker carries this on every run, so it is paid for on every turn of every conversation, and
 * there is no upper bound anybody would notice being missing. Four thousand is several paragraphs,
 * comfortably more than the "how we talk about ourselves" note this is for, and small enough beside
 * a context window that a person cannot quietly make every run expensive.
 */
export const INSTRUCTIONS_LIMIT = 4000;

/**
 * Somebody sent more than the cap.
 *
 * A named class rather than a boolean return, because the route has to answer 400 with a sentence
 * and every other outcome here is a success. Thrown by the store rather than only checked at the
 * route so the cap has ONE home: a second caller — a routine, an import, whatever arrives next —
 * cannot write past it by not knowing the rule existed.
 */
export class InstructionsTooLongError extends Error {
  constructor() {
    super(
      `Standing instructions are at most ${INSTRUCTIONS_LIMIT} characters.`,
    );
    this.name = "InstructionsTooLongError";
  }
}

export function createUserInstructionsStore(
  database: Database,
): UserInstructionsStore {
  return {
    async read(userId) {
      const [row] = await database
        .select({ instructions: userInstructions.instructions })
        .from(userInstructions)
        .where(eq(userInstructions.userId, userId))
        .limit(1);

      return row?.instructions ?? null;
    },

    async write(userId, text) {
      const instructions = text.trim();

      if (instructions.length > INSTRUCTIONS_LIMIT) {
        throw new InstructionsTooLongError();
      }

      /*
       * Emptying the box is deleting the row, not storing "".
       *
       * The two would read identically to a person and differently to everything else: the prompt
       * seam would have to know that an empty string means no block, the store would answer "" where
       * it had promised null, and "has this person written any" would stop being a row count. One
       * representation of none, and it is absence.
       */
      if (instructions.length === 0) {
        await database
          .delete(userInstructions)
          .where(eq(userInstructions.userId, userId));
        return "";
      }

      await database
        .insert(userInstructions)
        .values({ userId, instructions })
        .onConflictDoUpdate({
          target: userInstructions.userId,
          set: { instructions, updatedAt: new Date() },
        });

      return instructions;
    },
  };
}
