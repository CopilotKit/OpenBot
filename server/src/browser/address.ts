import { normaliseOpenBotOrigin } from "@openbot/shared/recorder-api";
import type { DeploymentConfig } from "../config";

/** `http://localhost:3001` as the address the Recorder takes for it: the Recorder reaches this machine by its loopback
 * address only, never by the name (Decision 21), and a server answers on 127.0.0.1 wherever it answers on localhost. */
function asRecorderTakesIt(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  const checked = normaliseOpenBotOrigin(url.origin);
  return checked.ok ? checked.origin : null;
}

/** An address on this machine itself: 127.0.0.1 or [::1], over http with a port, as only OpenBot on this machine has. */
function isThisMachine(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * Where the person's OpenBot browser reaches this OpenBot: its public origin, the address people's browsers use, in a
 * form the Recorder accepts (https, or http on a loopback address with a port).
 *
 * In order: the configured public URL (`OPENBOT_PUBLIC_URL`, else `BETTER_AUTH_URL`); then, for OpenBot running on this
 * machine, the address the person's own window is using, which OpenBot Desktop finds at runtime (127.0.0.1 or [::1],
 * whichever its app answered on) and so never configures; then the app's own address (`OPENBOT_APP_URL`, else the first
 * of `TRUSTED_ORIGINS`). The request's address is taken only when it is this machine's: never another site's, which
 * would hand the person's Recorder token to whoever sent the request. Null when none of them is one the Recorder takes.
 */
export function openbotAddress(
  config: Pick<DeploymentConfig, "publicUrl" | "appUrl">,
): (requestOrigin: string | undefined) => string | null {
  return (requestOrigin) => {
    const fromRequest = requestOrigin ? asRecorderTakesIt(requestOrigin) : null;
    for (const candidate of [
      config.publicUrl ? asRecorderTakesIt(config.publicUrl) : null,
      fromRequest && isThisMachine(fromRequest) ? fromRequest : null,
      config.appUrl ? asRecorderTakesIt(config.appUrl) : null,
    ])
      if (candidate) return candidate;
    return null;
  };
}
