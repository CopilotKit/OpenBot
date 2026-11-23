import { useEffect } from "react";
import type { Connecting } from "./ConnectToOpenBot";
import { ExternalLink } from "./ExternalLink";
import { StatusLine } from "./SetupProgress";
import { UpdateOpenBot } from "./UpdateOpenBot";

/**
 * OpenBot Cloud's address for programs: the OpenBot CopilotKit runs, on the name whose edge never
 * challenges a caller. This app connects to it, checks it, posts its sign-in code to it and calls
 * its API there. It is the same OpenBot as {@link OPENBOT_CLOUD_WEB_URL}.
 */
export const OPENBOT_CLOUD_URL = "https://api.open.bot";

/**
 * OpenBot Cloud's address for people: where the web app is, behind an edge that challenges bots.
 * What a person reads and opens in their browser. The sign-in page the browser is sent to is there
 * too, because OpenBot Cloud's own sign-in metadata says so.
 */
export const OPENBOT_CLOUD_WEB_URL = "https://my.open.bot";

/**
 * Whether this build offers OpenBot Cloud on the first screen. Off unless the build sets
 * `VITE_OPENBOT_CLOUD_ENABLED=true`: until Cloud is open to everybody, a build shows the first
 * screen without it (OpenBot (Self-Contained), OpenBot for Business, and connecting to an address).
 * Read when the screen draws, so a test can set it.
 */
export function cloudEnabled(): boolean {
  return (
    import.meta.env.VITE_OPENBOT_CLOUD_ENABLED?.trim().toLowerCase() === "true"
  );
}

/**
 * Where this build signs in to OpenBot Cloud. `VITE_OPENBOT_CLOUD_URL` points a build at another
 * OpenBot, such as a test stack; unset, it is {@link OPENBOT_CLOUD_URL}.
 */
export function cloudAddress(): string {
  return (
    import.meta.env.VITE_OPENBOT_CLOUD_URL?.trim() || OPENBOT_CLOUD_URL
  ).replace(/\/+$/, "");
}

/**
 * Where people open this build's OpenBot Cloud in a browser. `VITE_OPENBOT_CLOUD_WEB_URL` names it;
 * unset, it is {@link OPENBOT_CLOUD_WEB_URL}, or, for a build pointed at another OpenBot with
 * `VITE_OPENBOT_CLOUD_URL` alone, that one address, which is all a test stack has.
 */
export function cloudWebAddress(): string {
  const named = import.meta.env.VITE_OPENBOT_CLOUD_WEB_URL?.trim();
  if (named) return named.replace(/\/+$/, "");
  return import.meta.env.VITE_OPENBOT_CLOUD_URL?.trim()
    ? cloudAddress()
    : OPENBOT_CLOUD_WEB_URL;
}

/** The address as a person reads it: its host. */
export function cloudHost(address = cloudWebAddress()): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** The button that signs in. */
export const SIGN_IN_TO_CLOUD = "Sign in to OpenBot Cloud";

/** What happens when the person signs in: the browser, then straight back to this app. */
export const CLOUD_HAND_OFF =
  "You'll sign in or create an account in your browser, then come straight back here.";

/**
 * The first screen's lower half when OpenBot Cloud is picked: what it is, and the sign-in. This app
 * is OpenBot on the person's computer, connected to OpenBot Cloud, where their Bots run: the same
 * account, Bots and conversations as the web app. Cloud's address is built in, so there is nothing
 * to type. Signing in is the same as connecting to any OpenBot that runs elsewhere
 * (`useConnectToOpenBot` with that address): the shell checks the address, opens the person's
 * browser to sign in (OAuth with PKCE, the way a native app signs in), and shows OpenBot Cloud in
 * this window once they come back. OpenBot's own backend is not set up on this computer.
 *
 * While the browser is waited on, Cancel is the only control. What went wrong is the shell's
 * sentence in the same calm notice the address screen draws, and the button says what pressing it
 * again does.
 */
export function CloudSignIn({
  connecting,
  focus = false,
}: {
  connecting: Connecting;
  /** Picked by the person just now: the button has the focus, so Enter signs in. */
  focus?: boolean;
}) {
  const { phase, trouble, busy } = connecting;
  // Where the person uses OpenBot Cloud in a browser, not the address this app calls.
  const web = cloudWebAddress();
  const host = cloudHost(web);
  useEffect(() => {
    if (focus) connecting.action.current?.focus();
  }, [focus, connecting.action]);
  return (
    <section className="cloud-sign-in" aria-label="OpenBot Cloud">
      <p className="lede">
        This app connects to OpenBot Cloud, where your Bots run. Your account,
        Bots and conversations are the same here and at {host}.
      </p>
      {phase === "waiting" ? (
        <>
          <StatusLine>Finish signing in in your browser.</StatusLine>
          <div className="row">
            <button
              type="button"
              className="quiet"
              onClick={() => void connecting.cancel()}
            >
              Cancel
            </button>
          </div>
        </>
      ) : phase === "opening" ? (
        <StatusLine>Opening OpenBot…</StatusLine>
      ) : (
        <>
          {trouble && trouble.offer !== "update" && (
            <div className="local-alert needs" role="alert">
              <p>{trouble.problem.said}</p>
            </div>
          )}
          {trouble?.offer === "update" ? (
            <UpdateOpenBot said={trouble.problem.said} />
          ) : (
            <div className="row">
              <button
                type="button"
                ref={connecting.action}
                disabled={busy}
                onClick={() => void connecting.submit()}
              >
                {trouble?.offer === "sign-in"
                  ? "Sign in again"
                  : trouble && trouble.offer !== "browser"
                    ? "Try again"
                    : SIGN_IN_TO_CLOUD}
              </button>
              {trouble?.offer === "browser" && (
                <ExternalLink className="button-link" href={web}>
                  Open in browser
                </ExternalLink>
              )}
            </div>
          )}
          {phase === "checking" ? (
            <StatusLine>Reaching OpenBot Cloud…</StatusLine>
          ) : (
            <p className="footnote">{CLOUD_HAND_OFF}</p>
          )}
        </>
      )}
    </section>
  );
}
