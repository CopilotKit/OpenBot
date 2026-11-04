/** Durable, request-scoped browser handoff shared by the computer, API, and app. */
export type HandoffStatus =
  | "waiting"
  | "taken"
  | "completed"
  | "cancelled"
  | "expired"
  | "interrupted";
export type HandoffSource =
  | "model"
  | "cloudflare"
  | "visible-challenge"
  | "manual";
export type HandoffRequest = {
  id: string;
  toolCallId?: string;
  reason: string;
  source: HandoffSource;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  finishedAt?: string;
  interruption?: string;
  /**
   * The page the request was raised on, so a browser that comes back blank can be sent there again
   * before a person is asked to solve it. http(s) only; absent when the page was blank.
   */
  url?: string;
  /**
   * Set only on a request a restart interrupted while it still holds its page: the one case a later
   * request may reopen that page. A stop or reset clears it, and so does the help TTL running out.
   */
  keepsPage?: boolean;
};
export type ComputerControlState = {
  holder: "bot" | "human";
  since: string;
  requested: boolean;
  reason?: string;
  request?: HandoffRequest;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  /** A person had the page when the computer stopped, so they must check it before the Bot acts. */
  recoveryRequired: boolean;
  secretWanted?: string;
  secretRef?: string;
  secretSnapshotId?: number;
  /**
   * The user id of the person holding the wheel, while `holder` is `human` and they took it with `by`. Recording in a
   * Bot's browser and its bar are theirs alone (`shared/bot-browser.ts`).
   */
  heldBy?: string;
};
/**
 * Who asked for the wheel, of the two that can ask through `/control/request`: the Bot, stuck and asking a person to
 * step in (`model`, the default), or a person taking the wheel themselves (`manual`), whose reason is the app's own
 * words for asking rather than anything the Bot needs. The computer records the challenges it detects itself.
 */
export type RequestHelpSource = Extract<HandoffSource, "model" | "manual">;
export type RequestHelpInput = {
  reason: string;
  toolCallId?: string;
  source?: RequestHelpSource;
};
export type ControlRequestInput = {
  requestId: string;
  /** On a take: the user id of the person taking the wheel, kept as `heldBy`. The server always sends it. */
  by?: string;
};
export type BrowserChallenge = {
  kind: "cloudflare" | "visible-challenge";
  reason: string;
  requestId: string;
};
