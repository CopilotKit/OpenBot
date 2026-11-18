import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { DOESNT_UPDATE_ITSELF } from "../../shared/desktop-updates";
import type { Checked } from "./CheckForUpdates";
import { asProblem, InlineFailure, type Problem } from "./Problem";
import { type AppUpdate, describe } from "./UpdateOffer";

/**
 * The `kind` the shell gives a problem when this app is older than the OpenBot it talks to serves
 * (`client_version::APP_TOO_OLD`): connected to an OpenBot, such as OpenBot Cloud, that raised the
 * oldest app it serves, or with an OpenBot on this computer that needs a newer app.
 */
export const APP_TOO_OLD = "app-too-old";

/**
 * The same, when the minimum this app is below was raised because of a security problem in older
 * releases (`client_version::APP_TOO_OLD_SECURITY`). The shell's sentence says so, and the window
 * puts it where "Update OpenBot" would be.
 */
export const APP_TOO_OLD_SECURITY = "app-too-old-security";

/** Whether a problem is this app being too old for its OpenBot, for a security problem or not. */
export function appTooOld(problem: Problem | null | undefined): boolean {
  return problem?.kind === APP_TOO_OLD || forSecurity(problem);
}

/** Whether this app is too old for its OpenBot because of a security problem. */
export function forSecurity(problem: Problem | null | undefined): boolean {
  return problem?.kind === APP_TOO_OLD_SECURITY;
}

/** How often to ask the shell how an install is going, as Check for updates does. */
const PROGRESS_EVERY_MS = 500;

/** How many Update and restart buttons of this kind are on screen, and who wants to know. */
let showing = 0;
const watchers = new Set<() => void>();
function told() {
  for (const watcher of watchers) watcher();
}

/**
 * Whether an OpenBot that needs a newer app is being said on screen with its Update and restart.
 * The offer at the top of the window stands back while it is, so the window offers the update
 * once, in the card that says why.
 */
export function useUpdateOpenBotShowing(): boolean {
  return useSyncExternalStore(
    (changed) => {
      watchers.add(changed);
      return () => {
        watchers.delete(changed);
      };
    },
    () => showing > 0,
  );
}

/**
 * Update and restart, for an OpenBot that needs a newer version of this app. The same feed and the
 * same install as the update offer at the top of this window and Check for updates: the feed is read
 * now, and a newer version found is installed, and OpenBot restarts into it. A version the person
 * closed the offer on before is still installed: they asked.
 *
 * A build that never updates itself (internal, candidate, or without the updater) says so, with
 * nothing to press. When the feed has nothing newer, it says so and the button stays to try later.
 *
 * `said`: the sentence about the OpenBot, for a screen whose notice for it this draws (the connect
 * screen): the notice, then Update and restart under it.
 */
export function UpdateOpenBot({ said }: { said?: string } = {}) {
  const [updatesItself, setUpdatesItself] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">(
    "idle",
  );
  const [progress, setProgress] = useState<AppUpdate["installing"]>(null);
  const [found, setFound] = useState<Checked | null>(null);
  const [failure, setFailure] = useState<Problem | null>(null);
  const [installFailure, setInstallFailure] = useState<string | null>(null);

  useEffect(() => {
    showing += 1;
    told();
    return () => {
      showing -= 1;
      told();
    };
  }, []);

  useEffect(() => {
    let current = true;
    invoke<AppUpdate>("app_update_offer")
      .then((offer) => {
        if (current) setUpdatesItself(offer.updatesItself !== false);
      })
      // A shell that doesn't say still offers the update: the install says what it can't do.
      .catch(() => {
        if (current) setUpdatesItself(true);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== "installing") return;
    let current = true;
    const timer = setInterval(async () => {
      try {
        const offer = await invoke<AppUpdate>("app_update_offer");
        if (current) setProgress(offer.installing);
      } catch {
        // Progress is a courtesy. The button already says it is downloading.
      }
    }, PROGRESS_EVERY_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [phase]);

  async function update() {
    setFailure(null);
    setInstallFailure(null);
    setFound(null);
    setPhase("checking");
    let checked: Checked;
    try {
      checked = await invoke<Checked>("check_app_update");
    } catch (error) {
      setFailure(asProblem(error));
      setPhase("idle");
      return;
    }
    setFound(checked);
    if (checked.found !== "available" && checked.found !== "installing") {
      setPhase("idle");
      return;
    }
    setPhase("installing");
    try {
      // Returns only when it failed: on success the app restarts into the new version.
      await invoke("install_app_update");
    } catch (error) {
      setInstallFailure(asProblem(error).said);
      setPhase("idle");
      setProgress(null);
    }
  }

  const doesntUpdate = updatesItself === false || found?.found === "notOffered";
  const line = doesntUpdate && <p role="status">{DOESNT_UPDATE_ITSELF}</p>;
  // Given the sentence, the calm notice is drawn here, so a build that never updates itself says
  // so in it, in its type, as the card for the OpenBot on this computer does (`AppTooOld`).
  const notice = said !== undefined && (
    <div className="local-alert needs" role="alert">
      <p>{said}</p>
      {line}
    </div>
  );
  if (doesntUpdate) return notice || line;
  return (
    <>
      {notice}
      <div className="row">
        <button
          type="button"
          disabled={updatesItself === null || phase !== "idle"}
          onClick={() => void update()}
        >
          {phase === "checking"
            ? "Checking…"
            : phase === "installing"
              ? describe(progress)
              : "Update and restart"}
        </button>
      </div>
      {found?.found === "upToDate" && (
        <p role="status">
          OpenBot {found.current} is the newest version available. Check again
          later.
        </p>
      )}
      {installFailure && (
        <p className="caution" role="alert">
          OpenBot could not install the update: {installFailure}
        </p>
      )}
      {failure && <InlineFailure problem={failure} />}
    </>
  );
}

/**
 * An OpenBot that needs a newer version of this app, wherever setup shows a problem: the shell's
 * sentence, which says "Update OpenBot", and Update and restart. Nothing failed, so it is not drawn as
 * a failure: no "That didn't finish", no technical details, no troubleshooting logs. For a security
 * problem the shell's sentence is the heading, in place of "Update OpenBot", and is not said twice.
 */
export function AppTooOld({
  problem,
  headed = true,
}: {
  problem: Problem;
  /** False where the screen's own heading already says it. */
  headed?: boolean;
}) {
  const security = forSecurity(problem);
  return (
    // The calm notice the connect screen uses for a connection that didn't work, not the failure
    // card: nothing failed.
    <div className="local-alert needs app-too-old" role="alert">
      {headed && <h2>{security ? problem.said : "Update OpenBot"}</h2>}
      {!security && <p>{problem.said}</p>}
      <UpdateOpenBot />
    </div>
  );
}
