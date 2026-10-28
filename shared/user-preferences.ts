export type MessageListEmphasis = "agent" | "thread";

export type UserPreferences = {
  /** Set by profile saves so choosing a name finishes the first-run prompt. */
  profileNameSet?: boolean;
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting OpenBot. */
  selfHostBannerDismissed: boolean;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
};
