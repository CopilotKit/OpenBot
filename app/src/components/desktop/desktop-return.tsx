import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { buttonVariants } from "@/components/ui/button";
import { desktopShell } from "@/lib/desktop/shell";
import { confirmBrokeredConnectionMutationOptions } from "@/lib/plugins/mutations";

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
 * there as well (`desktopReturnUrlFor` on the server). This page does what the account's page does on
 * arrival, asking the server to confirm the account so it is recorded, and then hands the person back
 * to the window through `openbot://`. The window refreshes its apps when it has the focus again.
 *
 * Loaded in the Desktop window itself, it goes to the account's page instead, which confirms on its
 * own.
 */
export function DesktopReturn({
  app,
  openDesktop = (link: string) => window.location.assign(link),
}: {
  /** The app the sign-in was for, by its key. */
  app?: string;
  /** Follows the `openbot://` link. Replaced in tests, which cannot follow one. */
  openDesktop?: (link: string) => void;
}) {
  const navigate = useNavigate();
  const { mutate: confirm } = useMutation(
    confirmBrokeredConnectionMutationOptions(useQueryClient()),
  );
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (desktopShell()) {
      void navigate(
        app
          ? { to: "/connections/$key", params: { key: app } }
          : { to: "/connections" },
      );
      return;
    }
    // Handed back once the account is recorded, or once that failed: the window shows either.
    const handBack = () => openDesktop(DESKTOP_LINK);
    if (!app) {
      handBack();
      return;
    }
    confirm(app, { onSettled: handBack });
  }, [app, confirm, navigate, openDesktop]);

  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold">Back to OpenBot</h1>
        <p className="text-sm text-muted-foreground">
          OpenBot opens on its own. You can close this tab.
        </p>
        {/* An anchor rather than Button: Base UI gives a rendered anchor role="button", and this is a link. */}
        <a className={buttonVariants()} href={DESKTOP_LINK}>
          Open OpenBot
        </a>
      </div>
    </main>
  );
}
