import { RECORDER_NATIVE_HOST } from "@openbot/shared/recorder-extension";

export type DesktopHandoff = { openbotUrl: string; code: string };

async function ask(
  message: object,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      chrome.runtime.sendNativeMessage(RECORDER_NATIVE_HOST, message),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return reply && typeof reply === "object"
      ? (reply as Record<string, unknown>)
      : null;
  } catch {
    return null; // host not installed, or refused
  } finally {
    clearTimeout(timer);
  }
}

/** OpenBot Desktop's host answers a ping only after its running-app check, which waits up to 2 s on the local
 * OpenBot's /api/capabilities (`server_capabilities_answer` in desktop/src-tauri/src/main.rs) on a slow machine. */
const PING_TIMEOUT_MS = 3_000;
/** A handoff runs the same running-app check, then the host's own request for a connect code, which it gives up on
 * after 5 s (`client` in desktop/src-tauri/src/recorder_host.rs). */
const HANDOFF_TIMEOUT_MS = PING_TIMEOUT_MS + 5_000;

/** A ping that mints nothing. */
export async function desktopAvailable(
  timeoutMs = PING_TIMEOUT_MS,
): Promise<boolean> {
  return (await ask({ type: "ping" }, timeoutMs))?.available === true;
}

export async function askDesktopForHandoff(
  timeoutMs = HANDOFF_TIMEOUT_MS,
): Promise<DesktopHandoff | null> {
  const reply = await ask({ type: "handoff" }, timeoutMs);
  if (
    reply &&
    typeof reply.openbotUrl === "string" &&
    typeof reply.code === "string" &&
    reply.code.startsWith("obc_")
  )
    return { openbotUrl: reply.openbotUrl, code: reply.code };
  return null;
}
