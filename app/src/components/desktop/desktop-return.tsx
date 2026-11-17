import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCountdown } from "@/components/plugins/consent-handoff";
import { buttonVariants } from "@/components/ui/button";
import { desktopShell } from "@/lib/desktop/shell";
import { appNameFromKey } from "@/lib/plugins/consent-handoff";

/**
 * The link that brings OpenBot Desktop's window forward, on the page it is already showing.
 *
 * `openbot://open` with no page named: the window was left where the sign-in started (a conversation,
 * an app's page), and that is where the person goes back to (`open_from_link` in desktop/src-tauri).
 */
export const DESKTOP_LINK = "openbot://open";

/**
 * Where an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser
 * (`/desktop-return`).
 *
 * The Desktop window opens every site outside OpenBot in the browser, so the vendor's redirect lands
 * there as well (`desktopReturnUrlFor` on the server). That browser is not the window, and the
 * personal edition only admits requests carrying its install's token, which only the window has. So
 * this page is not behind sign-in and asks the API nothing: it hands the person back to the window
 * through `openbot://`, and the window confirms the account itself when it has the focus again,
 * whatever screen it is on (`confirmOnReturn` in lib/plugins/confirm-on-return.ts).
 *
 * IT SAYS HOW THE SIGN-IN WENT, FOR A COUNTDOWN, BEFORE IT HANDS BACK. Handing back at once took
 * the person to the window before they could read anything, so the page flashed by. What it says
 * comes from `status`, which the app's broker adds to the address on the way back (`success` or
 * `failed`). The window still confirms the account itself; this is only what to tell the person.
 *
 * Loaded in the Desktop window itself, it goes to the account's page instead, which confirms on its
 * own.
 */
export function DesktopReturn({
  app,
  status,
  openDesktop = (link: string) => window.location.assign(link),
}: {
  /** The app the sign-in was for, by its key. */
  app?: string;
  /** How the sign-in went, as the broker reported it on the way back. */
  status?: string;
  /** Follows the `openbot://` link. Replaced in tests, which cannot follow one. */
  openDesktop?: (link: string) => void;
}) {
  const navigate = useNavigate();
  const started = useRef(false);
  const inWindow = desktopShell() !== null;
  const [handedBack, setHandedBack] = useState(false);

  useEffect(() => {
    if (started.current || !inWindow) return;
    started.current = true;
    void navigate(
      app
        ? { to: "/connections/$key", params: { key: app } }
        : { to: "/connections" },
    );
  }, [app, inWindow, navigate]);

  const handBack = () => {
    if (handedBack) return;
    setHandedBack(true);
    openDesktop(DESKTOP_LINK);
  };
  const seconds = useCountdown(!inWindow && !handedBack, handBack);

  const name = app ? appNameFromKey(app) : null;
  const heading =
    status === "success"
      ? `${name ?? "Your account"} is connected`
      : status === "failed"
        ? `Couldn't connect ${name ?? "your account"}`
        : "Back to OpenBot";
  const line =
    status === "success"
      ? `Bots that have ${name ?? "the app"} can use it now.`
      : status === "failed"
        ? "Nothing was connected. You can try again in OpenBot."
        : null;

  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">{heading}</h1>
        {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
        {handedBack ? (
          <>
            <p className="text-sm text-muted-foreground" role="status">
              OpenBot opens on its own. You can close this tab.
            </p>
            {/* An anchor rather than Button: Base UI gives a rendered anchor role="button", and this is a link. */}
            <a
              className={buttonVariants({ variant: "outline" })}
              href={DESKTOP_LINK}
            >
              Open OpenBot
            </a>
          </>
        ) : (
          <>
            <p
              aria-live="polite"
              className="font-medium text-sm tabular-nums"
              data-testid="return-countdown"
            >
              Back to OpenBot in {Math.max(seconds, 0)}
            </p>
            <a
              className={buttonVariants()}
              href={DESKTOP_LINK}
              onClick={(event) => {
                event.preventDefault();
                handBack();
              }}
            >
              Back to OpenBot now
            </a>
          </>
        )}
      </div>
    </main>
  );
}
