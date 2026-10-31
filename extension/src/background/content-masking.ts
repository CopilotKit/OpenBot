// What a content script sends is masked once more in the service worker, with every sensitive-value digest the recording
// holds. A content script knows only what was typed into sensitive fields of its own document: a password typed on one
// page and then typed or pasted into an ordinary field on the next page, in another tab or in another frame, leaves its
// page unmasked. The service worker holds the digests of every document of the recording (content.sensitive), so here the
// value goes wherever it appears later: the edit's value and text, the attributes, label and name that copy it, its
// selectors, and anything else in the step.
import {
  type CapturedEvent,
  MIN_DIGEST_LENGTH,
  maskCollectorEvent,
  normaliseSecret,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";
import { AGENT_TARGET_FIELD } from "../shared/agent-target";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The content event masked with `digests`, or null for one that cannot be read. A field the masking judges sensitive here
 * (its label names a one-time code, say) that still holds its value had it redacted, and `keep` receives that value's
 * digest, so it goes from everything after too (the save's body and answer, the agent's events, the narration). The click's
 * private agent target is left as the page wrote it: the agent events read its ids and remove it.
 */
export function maskContentEvent(
  event: CapturedEvent,
  digests: ReadonlySet<string>,
  keep: (digest: string) => void,
): CapturedEvent | null {
  const value = event?.value;
  const target =
    isRecord(value) && AGENT_TARGET_FIELD in value
      ? value[AGENT_TARGET_FIELD]
      : undefined;
  const bare =
    target === undefined || !isRecord(value)
      ? event
      : {
          ...event,
          value: Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== AGENT_TARGET_FIELD),
          ) as CapturedEvent["value"],
        };
  const masked = maskCollectorEvent(
    bare,
    {
      sensitive: false,
      onSensitive: (typed) => {
        for (const item of typed) {
          const normalised = normaliseSecret(item);
          if (normalised.length >= MIN_DIGEST_LENGTH)
            keep(sha256HexSync(normalised));
        }
      },
    },
    { digests },
  );
  if (masked === null || target === undefined || !isRecord(masked.value))
    return masked;
  return {
    ...masked,
    value: { ...masked.value, [AGENT_TARGET_FIELD]: target },
  } as CapturedEvent;
}
