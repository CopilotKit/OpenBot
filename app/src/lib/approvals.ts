/**
 * The questions a boundary raised, from the browser's side: reading them, answering them, and
 * knowing which tool call each one belongs to.
 *
 * One module for all of it because the two halves have to agree. A tool call that met an `ask` rule
 * holds itself open waiting for an answer, and the card a person answers on is drawn on that same
 * tool call's line in the transcript. Those are different components on different render passes, so
 * the id travels through here.
 *
 * A question is held against the tool call that raised it rather than against the Bot. The Bot's
 * list is the wrong key: nothing withdraws a question when the wait around it ends, so pressing
 * Stop, reloading the tab or a turn that errors all leave an unanswered entry sitting in the
 * server's registry until it expires. A card that showed "the oldest thing this Bot is waiting on"
 * would then put a stale question in front of somebody on an unrelated line, record their Allow
 * against an action nobody is waiting for, and leave the action they were actually looking at
 * waiting out the full ten minutes.
 */

/**
 * How long the surface holds a tool call open for an answer, and how often it looks.
 *
 * Ten minutes matches the server's own window, so the wait ends because the question expired rather
 * than because the two sides disagreed about when it had.
 */
const WAIT_FOR_ANSWER_MS = 10 * 60_000;
const WAIT_POLL_MS = 1_000;

export type PendingApproval = {
  id: string;
  botId: string;
  /** The expression that asked, shown as a rule so a person can see which boundary they are at. */
  rule: string;
  /** What is about to happen, in one sentence. */
  question: string;
  requestedAt: string;
  expiresAt: string;
  /** Absent while nobody has answered. False is an answer. */
  granted?: boolean;
  answeredBy?: string;
};

/** A question one tool call is waiting on, as its own line in the transcript needs to draw it. */
export type OpenQuestion = {
  approvalId: string;
  botId: string;
  question: string;
  rule: string | null;
};

const open = new Map<string, OpenQuestion>();
const watchers = new Set<() => void>();

/**
 * Say that this tool call is waiting on an answer, so its line can draw the card.
 *
 * Handed over rather than fetched again: the server said all of it in the reply that paused the
 * call, and a card that re-derived its question from a list would be back to guessing which entry
 * in that list was its own.
 */
export function openQuestion(toolCallId: string, question: OpenQuestion): void {
  if (!toolCallId) return;
  open.set(toolCallId, question);
  for (const watcher of watchers) watcher();
}

/** The wait is over, whichever way it went. Nothing should still be offering buttons for it. */
export function closeQuestion(toolCallId: string): void {
  if (!open.delete(toolCallId)) return;
  for (const watcher of watchers) watcher();
}

export function questionOn(toolCallId: string): OpenQuestion | undefined {
  return open.get(toolCallId);
}

export function watchQuestions(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/**
 * The open questions for one Bot, or null if the server could not be asked.
 *
 * Null and an empty list are kept apart on purpose. A caller waiting for its own answer must not read
 * a failed request as "the question is gone", which is what an empty list means here.
 */
export async function readApprovals(
  botId: string,
): Promise<PendingApproval[] | null> {
  try {
    const response = await fetch(`/api/approvals/${botId}`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { approvals?: PendingApproval[] };
    return body.approvals ?? [];
  } catch {
    return null;
  }
}

export async function answerApproval(
  botId: string,
  approvalId: string,
  granted: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`/api/approvals/${botId}/${approvalId}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted }),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return {
      ok: false,
      error: body?.error ?? "That answer could not be recorded.",
    };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}

/**
 * Hold a tool call open until somebody answers its question.
 *
 * Polled rather than pushed. The answer arrives on a server this tab has no other channel to, and it
 * may well be given in a different tab or by a different person, so the only honest way to learn it
 * is to keep asking. A second between looks costs one request while a Bot is stopped and nothing at
 * all the rest of the time.
 */
export async function waitForApproval(
  botId: string,
  approvalId: string,
  signal: AbortSignal | undefined,
): Promise<"granted" | "declined" | "gave up" | "cancelled"> {
  const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
  while (Date.now() < deadline) {
    // Stop must work out of this wait as well, or pressing it leaves a Bot parked on a question
    // nobody is going to answer.
    if (signal?.aborted) return "cancelled";
    const approvals = await readApprovals(botId);
    if (approvals) {
      const mine = approvals.find((one) => one.id === approvalId);
      // Gone from a list we did read means it expired and was swept, which is the same outcome as
      // running out of patience here. A list we could NOT read says nothing, so it is not read as an
      // answer.
      if (!mine) return "gave up";
      if (mine.granted === true) return "granted";
      if (mine.granted === false) return "declined";
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}
