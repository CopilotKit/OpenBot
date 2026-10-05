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
};
export type ComputerControlState = {
  holder: "bot" | "human";
  since: string;
  requested: boolean;
  reason?: string;
  request?: HandoffRequest;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  secretWanted?: string;
  secretRef?: string;
  secretSnapshotId?: number;
};
export type RequestHelpInput = { reason: string; toolCallId?: string };
export type ControlRequestInput = { requestId: string };
export type BrowserChallenge = {
  kind: "cloudflare" | "visible-challenge";
  reason: string;
  requestId: string;
};
