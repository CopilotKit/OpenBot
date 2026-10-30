export type MessageListEmphasis = "agent" | "thread";

export type NarrationPreference = "on" | "off";
/** Whether this person's Bots check in on their behalf at all. */
export type ProactivePreference = "on" | "off";
/**
 * Every skin OpenBot ships. `openbot` is the default and is OpenBot exactly as it is without a
 * skin: no frame of its own, no tokens of its own.
 *
 * Here rather than in the app because the choice is saved on the person's account, so the server
 * has to know which values it may store.
 */
export const SKIN_IDS = [
  "openbot",
  "openduet",
  "opendots",
  "openmuse",
] as const;

export type SkinId = (typeof SKIN_IDS)[number];

export const DEFAULT_SKIN: SkinId = "openbot";

export function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.some((id) => id === value);
}

export type UserPreferences = {
  /** Set by profile saves so choosing a name finishes the first-run prompt. */
  profileNameSet?: boolean;
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting OpenBot. */
  selfHostBannerDismissed: boolean;
  /**
   * Whether this person narrates their recordings in OpenBot's Browser: the page listens to their microphone (hosted
   * OpenBot), or the Recorder in their browser does (OpenBot Desktop), only when it is `on`. Null until they chose, which
   * the Browser page asks before their first recording; the microphone stays closed until then.
   */
  narration: NarrationPreference | null;
  /** How OpenBot looks for this person, on every device they sign in from. */
  skin: SkinId;
  /**
   * Check-ins for all of this person's Bots. On by default; `off` stops every Bot's background
   * checks for them before any model call, whatever each Bot's own setting says. Each Bot's own
   * on, off and interval stay as they were, so turning this back on restores them.
   */
  proactive: ProactivePreference;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  narration: null,
  skin: DEFAULT_SKIN,
  proactive: "on",
};
