/**
 * The questions a Bot is waiting on a person to answer, and the binding that makes an answer mean
 * exactly one thing.
 *
 * In memory, per process, and deliberately not in the database. A pending question is about a live
 * browser session and a live turn: the snapshot the refs came from, the page that is open, the model
 * that is mid-run holding the tool call. A restart takes all three with it, so a persisted approval
 * would come back as a grant for an action nobody could still perform, attached to a conversation
 * nobody is having. Worse, it would be a grant nobody remembers giving. The safe reading of a
 * restart is that every open question was withdrawn, and the safe way to guarantee that is to keep
 * the questions somewhere a restart empties.
 *
 * The important part is the fingerprint. An approval registry without one is a dialog box: a person
 * presses Allow, an id comes back, and the model may then spend that id on any action it likes.
 * Binding an approval to a hash of the action it was granted for is what stops "yes, click Place
 * order" being replayable as "yes, click Delete account", and it is the reason this is a governance
 * feature rather than a confirmation prompt.
 */
import { createHash, randomUUID } from "node:crypto";

/**
 * How long a question stays open.
 *
 * Ten minutes, the same window the surface gives a person to answer a request for help or a secret.
 * Long enough that somebody who walked away from the screen can still come back and decide; finite
 * because a run holding a tool call open forever is a hung Bot, and because an approval that outlives
 * anybody's memory of the question is not consent.
 */
export const APPROVAL_TTL_MS = 10 * 60_000;

/**
 * The action an approval is about, in the fields a fingerprint is taken over.
 *
 * Everything here is known to the gateway before it acts and is derived from the request it is
 * actually about to make, never from anything the model asserted about it.
 */
export type ApprovalSubject = {
  botId: string;
  toolName: string;
  ref?: string | undefined;
  key?: string | undefined;
  filePath?: string | undefined;
  pageUrl?: string | undefined;
};

export type PendingApproval = {
  id: string;
  botId: string;
  /** Who was driving the Bot when it met the rule. Not necessarily who answers. */
  actor: string;
  /** The expression that asked, so the surface and the trail can name the boundary. */
  rule: string;
  /** What is about to happen, in one sentence, as the policy phrased it. */
  question: string;
  /**
   * The action this approval is good for, and only this one.
   *
   * Kept on the record rather than recomputed at consumption time from whatever arrives, because the
   * whole point is to compare the action a person saw against the action being attempted.
   */
  fingerprint: string;
  requestedAt: string;
  expiresAt: string;
  /** Undefined until somebody answers. False is an answer, and a final one. */
  granted?: boolean;
  /** Who answered, recorded so the audit row credits the decision to a person rather than to a Bot. */
  answeredBy?: string;
};

export type ApprovalAnswer =
  | { ok: true; approval: PendingApproval }
  /** One reason, because a person acts on all three identically: that question is no longer open. */
  | { ok: false; reason: "no longer open" };

export type ApprovalConsumption =
  | { ok: true; approval: PendingApproval }
  | {
      ok: false;
      reason: "unknown" | "unanswered" | "declined" | "a different action";
    };

/**
 * Thrown when somebody answers a question that is not open any more.
 *
 * Its own type so the routes can report it as a conflict rather than a fault: nothing is broken, the
 * question expired or was already answered, most likely in another tab.
 */
export class ApprovalNotPendingError extends Error {
  constructor() {
    super(
      "That request is no longer waiting for an answer. It may have expired, or somebody else answered it.",
    );
    this.name = "ApprovalNotPendingError";
  }
}

/**
 * A stable hash of the action, used to bind one approval to one thing.
 *
 * Hashed rather than stored as a tuple so the value is a single opaque string that can be compared in
 * one line and cannot be partially matched by accident. The parts are joined with a NUL, which no
 * field can contain, so that a ref of "a" with a key of "bc" cannot produce the same fingerprint as
 * "ab" with "c".
 *
 * The Bot's id is in here first, which is what stops an approval granted on one Bot's computer being
 * spent on another's: two Bots doing the identical thing produce two different fingerprints, and
 * neither can consume the other's.
 */
export function fingerprintOf(subject: ApprovalSubject): string {
  return createHash("sha256")
    .update(
      [
        subject.botId,
        subject.toolName,
        subject.ref ?? "",
        subject.key ?? "",
        subject.filePath ?? "",
        subject.pageUrl ?? "",
      ].join("\u0000"),
    )
    .digest("hex");
}

export type ApprovalRegistry = {
  /** Open a question. The id it returns is what a caller presents once somebody has answered. */
  request: (input: {
    botId: string;
    actor: string;
    rule: string;
    question: string;
    fingerprint: string;
  }) => PendingApproval;
  /**
   * The open questions for one Bot, newest last, expired ones already gone.
   *
   * Includes answered-but-unspent ones, because the waiting caller learns the answer by finding its
   * own id in this list. The surface shows only the unanswered ones.
   */
  pending: (botId: string) => PendingApproval[];
  answer: (id: string, actor: string, granted: boolean) => ApprovalAnswer;
  /** Spend an approval on one action. Single use: a successful consumption removes it. */
  consume: (id: string, fingerprint: string) => ApprovalConsumption;
};

export function createApprovalRegistry(
  options: {
    /** Injectable so expiry can be tested without a test that sleeps for ten minutes. */
    now?: () => number;
    ttlMs?: number;
  } = {},
): ApprovalRegistry {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  const open = new Map<string, PendingApproval>();

  /**
   * Drop what has run out, on every read.
   *
   * On read rather than on a timer, because a timer keeps a process alive and adds a thing that can
   * be forgotten in a test; nothing here matters until somebody looks, and everything that looks
   * sweeps first.
   */
  const sweep = () => {
    const at = now();
    for (const [id, approval] of open) {
      if (Date.parse(approval.expiresAt) <= at) open.delete(id);
    }
  };

  return {
    request: (input) => {
      sweep();
      const at = now();
      const approval: PendingApproval = {
        id: randomUUID(),
        botId: input.botId,
        actor: input.actor,
        rule: input.rule,
        question: input.question,
        fingerprint: input.fingerprint,
        requestedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ttlMs).toISOString(),
      };
      open.set(approval.id, approval);
      return approval;
    },

    pending: (botId) => {
      sweep();
      return [...open.values()].filter((approval) => approval.botId === botId);
    },

    answer: (id, actor, granted) => {
      sweep();
      const approval = open.get(id);
      // An answered question is not answerable again, whichever way it went. Otherwise a second
      // person, or the same person in a second tab, can quietly overturn a decision that the trail
      // has already recorded as made.
      if (!approval || approval.granted !== undefined) {
        return { ok: false, reason: "no longer open" };
      }
      const answered: PendingApproval = {
        ...approval,
        granted,
        answeredBy: actor,
      };
      open.set(id, answered);
      return { ok: true, approval: answered };
    },

    consume: (id, fingerprint) => {
      sweep();
      const approval = open.get(id);
      if (!approval) return { ok: false, reason: "unknown" };
      if (approval.granted === undefined) {
        return { ok: false, reason: "unanswered" };
      }
      if (approval.granted === false) return { ok: false, reason: "declined" };
      if (approval.fingerprint !== fingerprint) {
        // Left in place rather than burned. A mismatch is the replay this whole mechanism exists to
        // stop, and destroying the approval on the way past would let a model that guessed wrong take
        // the person's grant away from the action they actually meant it for.
        return { ok: false, reason: "a different action" };
      }
      // Single use. A grant is permission for one thing to happen once; leaving it spendable would
      // make "yes" mean "yes, as often as you like", which is not what anybody pressing Allow on one
      // button thinks they are agreeing to.
      open.delete(id);
      return { ok: true, approval };
    },
  };
}
