export type MessageListEmphasis = "agent" | "thread";

export type NarrationPreference = "on" | "off";

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
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  narration: null,
};
