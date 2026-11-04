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
    return failedComputerCall(response.status, body);
  }

  return { ok: true, ...(body ?? {}) };
}

/**
 * What a Bot is told when a computer call came back refused or failed.
 *
 * A result, never a thrown error. The SDK starts no follow-up run after a frontend tool throws, so a
 * throw ends the Bot's turn on the spot with nothing said; a result reaches the model, which can take
 * a fresh snapshot, pick another field, or tell the person what stopped it. Shared with the approval
 * gate's wrapper, which reaches the same computer by another route and must answer the same way.
 */
export function failedComputerCall(
  status: number,
  body: Record<string, unknown> | null,
): ToolOutcome {
  /*
   * A cold start that outlasted the server's wait. Said as what it is: the computer is starting, this
   * call did nothing, and asking again shortly is the right next step. Kept apart from the failures
   * below so the line in the transcript reads as a wait, and so the model is not handed something
   * that looks like a broken computer and gives up on one seconds from ready.
   */
  if (body?.starting === true) {
    return {
      ok: false,
      starting: true,
      notPerformed: true,
      reason:
        typeof body.error === "string"
          ? body.error
          : "The computer is still starting. This call was not performed. Try it again in a moment.",
    };
  }
  /*
   * A rule wants to ask about this call, and it went straight to the computer without its
   * conversation. Nothing was done. `useFrontendTool` in approval-tools sends it again through the
   * approval route, so this result only reaches the Bot from a surface with no conversation at all.
   */
  if (body?.needsConversation === true) {
    return {
      ok: false,
      needsConversation: true,
      notPerformed: true,
      reason:
        typeof body.error === "string"
          ? body.error
          : "This action needs your approval in a chat with this Bot.",
    };
  }
  return {
    ok: false,
    reason: typeof body?.error === "string" ? body.error : "That did not work.",
    // Preserve refusal/stale-ref/control distinctions for the model's next step.
    ...(status === 403 ? { refused: true, rule: body?.rule ?? null } : {}),
    ...(status === 409
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
