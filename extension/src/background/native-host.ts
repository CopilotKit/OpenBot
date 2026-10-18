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

/** A ping that mints nothing. */
export async function desktopAvailable(timeoutMs = 1000): Promise<boolean> {
  return (await ask({ type: "ping" }, timeoutMs))?.available === true;
}

export async function askDesktopForHandoff(
  timeoutMs = 5000,
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
