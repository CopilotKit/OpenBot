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
export type SecretEnding = {
  id: string;
  supplied: boolean;
  /** Why nothing was typed, said to the Bot. Absent on a value that was typed. */
  reason?: string;
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
  /** The open secret request, while the Bot waits for a value a person types (`computer_request_secret`). */
  secretId?: string;
  secretWanted?: string;
  secretRef?: string;
  secretSnapshotId?: number;
  /**
   * How the last secret request ended: its value typed into the field (`supplied`), or ended without
   * one and why. The request going away does not say which, and a Bot that read every ending as typed
   * submitted forms with the field empty.
   */
  secretEnded?: SecretEnding;
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

/**
 * How a Bot asks for a value it must not be told (`computer_request_secret`), said the same way by the
 * browser's tool, the server's and the standing instructions (`bot-prompt.ts`).
 *
 * WITHOUT A CLICK. All three used to say to click the field first. A click on a password field is a
 * credential typed on a website to the approval gate (`safetyRequirement` in
 * `server/src/approvals/policy.ts`), which hands that step to the person: a Bot that did as it was told
 * handed the whole browser over on the click and never reached the masked box. The box needs no click.
 * The value goes into the field the ref names, which the computer clicks and fills itself when the
 * person sends it (`/human/secret` in `agent-computer/src/index.ts`). The gate is right to hand a
 * Bot's own click there to the person, so the words changed, not the rule.
 */
export const SECRET_FIELD_BY_REF =
  "Give the ref of the field from your most recent snapshot and the snapshotId it came from. Do not click or type into the field first: the value goes into the field that ref names, and clicking a password field hands that step to the person instead.";

/**
 * A computer step's answer, with when it finished (`finishedAt`), for the time beside it in Activity.
 *
 * Activity used to time a step by the page watching it run, and the conversation it reads said what a
 * step did and not when. The steps the server takes after a person allows one never pass through the
 * page, so their rows had no time; nor did any row once the conversation was opened again. Said in
 * the answer the conversation keeps, every step has it: stamped by the server for a step it runs
 * (`headless-tools.ts`) and by the browser for one it runs (`approval-tools.tsx`). An answer that
 * already says, and the placeholder a step waiting on a person leaves, are left as they are.
 */
export function withFinishedAt(answer: unknown): unknown {
  if (!answer || typeof answer !== "object" || Array.isArray(answer))
    return answer;
  if ("finishedAt" in answer || (answer as { waiting?: unknown }).waiting)
    return answer;
  return { ...answer, finishedAt: new Date().toISOString() };
}
