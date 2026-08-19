/**
 * Reading and answering the questions a boundary raised, from the browser.
 *
 * Beside the control helpers rather than inside either thing that uses them, because two surfaces
 * ask the same server the same question for different reasons: the card in the transcript is looking
 * for something to put in front of a person, and the tool call is looking for its own answer. One
 * shape for both, so they cannot disagree about what an unanswered question looks like.
 */

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
    const response = await fetch(`/api/computers/${botId}/approvals`, {
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
    const response = await fetch(
      `/api/computers/${botId}/approvals/${approvalId}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ granted }),
      },
    );
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
