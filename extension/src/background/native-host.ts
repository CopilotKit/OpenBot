import { RECORDER_NATIVE_HOST } from "@openbot/shared/recorder-extension";

export type DesktopHandoff = { openbotUrl: string; code: string };
/** Why OpenBot Desktop did not hand over a connect code: the host's own error code (`not-running`, `not-signed-in` and
 * the rest), `no-answer` when the host is missing or did not answer in time, or `handoff-failed` for a reply of
 * another shape. */
export type DesktopRefusal = { error: string };

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

/** The host answers a ping within its own 2 s deadline (DEADLINES in desktop/src-tauri/src/recorder_host.rs); the
 * extension waits a little longer. */
const PING_TIMEOUT_MS = 3_000;
/** The host answers a handoff, its request to the local OpenBot for a connect code included, within its own 7 s
 * deadline (DEADLINES in recorder_host.rs); the extension waits a little longer. */
const HANDOFF_TIMEOUT_MS = 8_000;

/** The host answers an address within its own 7 s deadline (DEADLINES in recorder_host.rs): it runs the handoff's
 * ownership checks, without the request for a code. The extension waits a little longer, as it does for a handoff. */
const ADDRESS_TIMEOUT_MS = 8_000;

/** A ping that mints nothing. */
export async function desktopAvailable(
  timeoutMs = PING_TIMEOUT_MS,
): Promise<boolean> {
  return (await ask({ type: "ping" }, timeoutMs))?.available === true;
}

/**
 * The address OpenBot Desktop's own OpenBot answers on, on this computer, as its native host confirms it once that
 * deployment's own processes are proved to hold its ports. Null when there is no OpenBot Desktop here, it runs no
 * OpenBot, or it did not answer (an OpenBot Desktop from before this message answers `unknown-message`). It mints
 * nothing and carries nothing secret. Any program on this computer can serve a page on a loopback port, so this, and
 * never the page's own address, is what makes a loopback page OpenBot Desktop's.
 */
export async function desktopAddress(
  timeoutMs = ADDRESS_TIMEOUT_MS,
): Promise<string | null> {
  const reply = await ask({ type: "address" }, timeoutMs);
  return reply?.ok === true && typeof reply.openbotUrl === "string"
    ? reply.openbotUrl
    : null;
}

/** The host's handoff, or why there is none. A good ping does not promise a good handoff: the ping is cheap, and only
 * the handoff checks that OpenBot answers and that the organization sign-in can be handed over. */
export async function askDesktopForHandoff(
  timeoutMs = HANDOFF_TIMEOUT_MS,
): Promise<DesktopHandoff | DesktopRefusal> {
  const reply = await ask({ type: "handoff" }, timeoutMs);
  if (!reply) return { error: "no-answer" };
  if (
    reply.ok !== false &&
    typeof reply.openbotUrl === "string" &&
    typeof reply.code === "string" &&
    reply.code.startsWith("obc_")
  )
    return { openbotUrl: reply.openbotUrl, code: reply.code };
  if (typeof reply.error === "string" && reply.error.length > 0)
    return { error: reply.error };
  return { error: "handoff-failed" };
}
