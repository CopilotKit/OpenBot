import { tryClient } from "@/lib/client";
import { reportComputerActivity } from "@/lib/copilot/computer-activity";

export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * Exported for the test that covers what a Bot is told when a call is refused.
 *
 * The distinctions this draws from a status and a body decide the model's next step, and they are
 * drawn nowhere else, so they are worth pinning without standing up the tool registrations and the
 * runtime around them.
 */
export async function callComputer(
  botId: string,
  path: string,
  /*
   * A body, not a `RequestInit`. The client serialises it, so a caller that stringified first would
   * send a JSON string of a JSON string — which is what happened, briefly, when this moved over.
   */
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  // Announce before the call so the screen can open while the action is running.
  reportComputerActivity(botId);
  let response: Response;
  try {
    response = await tryClient(`/api/computers/${botId}${path}`, {
      method: init?.method,
      body: init?.body,
      // Abort cancels the request and prevents later actions, but cannot undo browser work already executing.
      signal,
    });
  } catch (error) {
    // An abort is a stopped run, not a computer failure.
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, reason: "Stopped.", stopped: true };
    }
    return {
      ok: false,
      reason: "The assistant's computer could not be reached.",
    };
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    return {
      ok: false,
      reason: (body?.error as string) ?? "That did not work.",
      // Preserve refusal/stale-ref/control distinctions for the model's next step.
      ...(response.status === 403
        ? { refused: true, rule: body?.rule ?? null }
        : {}),
      ...(response.status === 409
        ? body?.humanHasControl === true
          ? {
              humanHasControl: true,
              requestId: body?.requestId,
              handoff: body?.handoff,
            }
          : body?.snapshotRequired === true
            ? { staleRefs: true, snapshotRequired: true }
            : { staleRefs: true }
        : {}),
    };
  }

  return { ok: true, ...(body ?? {}) };
}
