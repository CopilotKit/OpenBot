export type MessageListEmphasis = "agent" | "thread";

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
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting OpenBot. */
  selfHostBannerDismissed: boolean;
  /** How OpenBot looks for this person, on every device they sign in from. */
  skin: SkinId;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  skin: DEFAULT_SKIN,
};
