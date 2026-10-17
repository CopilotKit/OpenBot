import { tryClient } from "@/lib/client";
import {
  reportComputerActivity,
  withdrawComputerActivity,
} from "@/lib/copilot/computer-activity";

export type ToolOutcome = Record<string, unknown> & { ok: boolean };

/**
 * The calls that never reach the Bot's screen.
 *
 * Reading a file or running a command happens on the computer, not on the display, so announcing
 * them opened the live screen on whatever still page was already there — a pane that arrived for an
 * action nobody could see, which is indistinguishable from one that arrived for no reason.
 *
 * A LIST OF EXCEPTIONS, NOT A LIST OF PERMITS, and deliberately so: a browser path added later and
 * never added here goes on announcing itself, which is what every browser path already does. The
 * failure mode of forgetting this list is a pane that opens, not one that silently stops.
 */
const OFF_SCREEN_PATHS = new Set([
  "/files/list",
  "/files/read",
  "/files/write",
  "/exec",
]);

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
  const run = OFF_SCREEN_PATHS.has(path) ? null : reportComputerActivity(botId);
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
    /*
     * A REFUSAL IS AN INTENTION, NOT AN ACTION. 403 is a policy, a capability switch or a network
     * rule saying no, and it says so before the browser is touched: there is nothing on the screen
     * to see, because nothing was done to it. Every other failure reached the computer and may have
     * moved it, so those keep the screen they opened.
     */
    if (response.status === 403 && run !== null)
      withdrawComputerActivity(botId, run);
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
