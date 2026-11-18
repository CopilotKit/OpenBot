import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { DOESNT_UPDATE_ITSELF } from "../../shared/desktop-updates";
import type { Checked } from "./CheckForUpdates";
import { asProblem, InlineFailure, type Problem } from "./Problem";
import { type AppUpdate, describe } from "./UpdateOffer";

/**
 * The `kind` the shell gives a problem when this app is older than the OpenBot it talks to serves
 * (`client_version::APP_TOO_OLD`): connected to a company's OpenBot whose admin raised the oldest
 * app it serves, or with an OpenBot on this computer that needs a newer app.
 */
export const APP_TOO_OLD = "app-too-old";

/** Whether a problem is this app being too old for its OpenBot. */
export function appTooOld(problem: Problem | null | undefined): boolean {
  return problem?.kind === APP_TOO_OLD;
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
 */
export function UpdateOpenBot() {
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

  if (updatesItself === false || found?.found === "notOffered") {
    return <p role="status">{DOESNT_UPDATE_ITSELF}</p>;
  }
  return (
    <>
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
 * a failure: no "That didn't finish", no technical details, no troubleshooting logs.
 */
export function AppTooOld({
  problem,
  headed = true,
}: {
  problem: Problem;
  /** False where the screen's own heading already says "Update OpenBot". */
  headed?: boolean;
}) {
  return (
    // The calm notice the connect screen uses for a connection that didn't work, not the failure
    // card: nothing failed.
    <div className="local-alert needs app-too-old" role="alert">
      {headed && <h2>Update OpenBot</h2>}
      <p>{problem.said}</p>
      <UpdateOpenBot />
    </div>
  );
}
