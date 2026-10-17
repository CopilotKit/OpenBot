// Feature off until Task 8 replaces it. Answers nothing; the router (Task 9) owns every listener.
import type {
  ExternalResponse,
  ExternalToBackground,
  PageResponse,
  PageToBackground,
} from "../protocol/messages";
import { type ConnectionRecord, readLocal } from "../shared/storage";

export function installConnection(): void {}

export async function currentConnection(): Promise<ConnectionRecord | null> {
  return (await readLocal("connection")) ?? null;
}

export async function forgetConnection(
  _reason: "revoked" | "removed" | "organization" | "disconnected",
): Promise<void> {}

/** page.connect.*, page.disconnect, page.desktop.available, page.connect.desktop; undefined for anything else. */
export async function handleConnectionMessage(
  message: PageToBackground,
): Promise<PageResponse | undefined> {
  if (message.type === "page.connect.pending")
    return { ok: true, pending: null };
  if (message.type === "page.desktop.available")
    return { ok: true, available: false };
  return undefined;
}

/** openbot.ping and openbot.connect from OpenBot's web page. */
export async function handleExternalConnect(
  _message: ExternalToBackground,
  _sender: chrome.runtime.MessageSender,
): Promise<ExternalResponse> {
  return { ok: false, error: "invalid" };
}

/** Compares the stored connection with the policy once (Task 22 makes it real); called by installConnection at every start. */
export async function reconcilePolicy(): Promise<void> {}

export async function offerDesktopConnection(): Promise<boolean> {
  return false;
}
