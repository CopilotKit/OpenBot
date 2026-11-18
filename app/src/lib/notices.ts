import { STAR_ON_GITHUB } from "@openbot/shared/notices";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import type { QueryClient } from "@tanstack/react-query";
import { recordNudgeEvent } from "@/lib/api/generated/product-events/product-events";
import { idempotencyKey } from "@/lib/api/request";
import { authKeys } from "@/lib/auth/queries";
import { ClientError } from "@/lib/client";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { organizationId } from "@/lib/organizations/current";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

/**
 * NOTICES A PERSON IS SHOWN ONCE: NUDGES (shared/notices.ts).
 *
 * The browser decides nothing about when one is due. The server works it out on every read of the
 * person's preferences (`noticesDue`), from the edition and how they have used OpenBot, and leaves
 * out any they dismissed (`dismissedNotices`). What the browser does is draw the card, save the
 * answer, count it, and read the preferences again at a moment that could have made one due: a
 * copied answer, a turn that ended somewhere, a Bot's reply.
 */

/** Whether the server says this notice is due for this person now, and they have not answered it. */
export function noticeDue(
  preferences:
    | Pick<UserPreferences, "dismissedNotices" | "noticesDue">
    | undefined,
  id: string,
): boolean {
  if (!preferences) return false;
  if ((preferences.dismissedNotices ?? []).includes(id)) return false;
  return (preferences.noticesDue ?? []).includes(id);
}

/**
 * Whether a moment could make any notice due here: the personal edition (the only one with a
 * nudge today), the person and their preferences loaded, and a nudge they have not answered. Read
 * from what the app already loaded, so asking costs nothing.
 */
function mightBecomeDue(
  queryClient: QueryClient,
): { userId: string } | undefined {
  const capabilities = queryClient.getQueryData<DeploymentCapabilities>(
    deploymentKeys.capabilities(),
  );
  if (capabilities?.edition !== "personal") return undefined;
  const userId = queryClient.getQueryData<{ id?: string } | null>(
    authKeys.currentUser(),
  )?.id;
  if (!userId) return undefined;
  const preferences = queryClient.getQueryData(
    userPreferencesQueryOptions(userId).queryKey,
  );
  if (!preferences) return undefined;
  // Every nudge there is, answered: nothing a moment could bring.
  const answered = new Set(preferences.dismissedNotices ?? []);
  if (NUDGES.every((id) => answered.has(id))) return undefined;
  return { userId };
}

/** The nudges this app draws. A new one is added here and given its card. */
const NUDGES: readonly string[] = [STAR_ON_GITHUB];

let pendingRead: ReturnType<typeof setTimeout> | undefined;

/**
 * A moment that could have made a nudge due: read the person's preferences again, so the server's
 * answer reaches the card right after the win. Only where a nudge could come of it at all (see
 * {@link mightBecomeDue}): a team's OpenBot, or somebody who answered every nudge, asks for nothing.
 *
 * `afterMs` waits a little for a moment the server records after telling the app (a routine's run
 * and a task's report are each said in the conversation a moment before their outcome is written),
 * and folds a burst of events into one read.
 */
export function nudgeMoment(
  queryClient: QueryClient,
  { afterMs = 0 }: { afterMs?: number } = {},
): void {
  if (!mightBecomeDue(queryClient)) return;
  if (pendingRead) clearTimeout(pendingRead);
  pendingRead = setTimeout(() => {
    pendingRead = undefined;
    const due = mightBecomeDue(queryClient);
    if (!due) return;
    void queryClient
      .fetchQuery({
        ...userPreferencesQueryOptions(due.userId),
        staleTime: 0,
      })
      .catch(() => {
        // A read that failed changes nothing on screen; the next moment asks again.
      });
  }, afterMs);
}

/** What a person did with a nudge: `NudgeEvent.action` in api/openapi/conversations.yaml. */
export type NudgeAction = "shown" | "clicked" | "dismissed";

/**
 * Count a nudge shown, followed or dismissed, and where. Best effort: the server works out who and
 * which moment made it due, and a count that does not arrive changes nothing on screen. Never
 * throws, so a caller can fire and forget. With keepalive, because following the star nudge leaves
 * the page as it is pressed.
 */
export async function recordNudge(
  nudge: string,
  action: NudgeAction,
  place: "card" | "settings",
): Promise<void> {
  try {
    await recordNudgeEvent(
      organizationId(),
      {
        nudge,
        action,
        place,
        surface: desktopShell() === null ? "web" : "desktop",
      },
      { "Idempotency-Key": idempotencyKey() },
      { keepalive: true },
    );
  } catch (error) {
    if (error instanceof ClientError)
      console.warn("Nudge telemetry was not accepted.", error.status);
    else console.warn("Nudge telemetry could not be delivered.");
  }
}
