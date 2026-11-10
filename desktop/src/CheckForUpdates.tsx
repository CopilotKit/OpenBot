import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  DOESNT_UPDATE_ITSELF,
  type UpdateReadiness,
  updateOffered,
} from "../../shared/desktop-updates";
import { asProblem, InlineFailure, type Problem } from "./Problem";
import { type AppUpdate, describe } from "./UpdateOffer";

/** What the shell found when asked, as `app_update::Asked` names it. */
export type Checked =
  | {
      found: "available";
      version: string;
      current: string;
      ready?: UpdateReadiness | null;
    }
  | { found: "upToDate"; current: string }
  | { found: "installing"; version: string; current: string }
  | { found: "notOffered"; current: string };

/** How often to ask the shell how an install is going, as the offer at the top does. */
const PROGRESS_EVERY_MS = 500;
/** How often to ask how ready a newer version found is, as the offer at the top does. */
const READY_EVERY_MS = 5_000;

/**
 * Whether this build updates itself, as the shell's offer says: `null` while asking, `"unknown"` if
 * the shell didn't answer (the check still says what it finds).
 */
type UpdatesItself = boolean | "unknown" | null;

/**
 * Check for updates, in the setup window. The shell reads the update feed at once and says what it
 * found: up to date, or the newer version with Update and restart.
 *
 * The same feed and the same install as the offer at the top of this window, the banner in
 * OpenBot's own page, and Check for Updates… in the menus. Asked for, a newer version is named even
 * if this person closed the offer on it before.
 *
 * A build that never updates itself (internal, candidate, or without the updater) says so up front,
 * with nothing to check: it never promises updates it can't install.
 */
export function CheckForUpdates() {
  const [updatesItself, setUpdatesItself] = useState<UpdatesItself>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<Problem | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<AppUpdate["installing"]>(null);
  const [installFailure, setInstallFailure] = useState<string | null>(null);
  const [ready, setReady] = useState<UpdateReadiness | null>(null);

  useEffect(() => {
    let current = true;
    // A read of the shell's memory, not of the feed: the feed is read only when somebody checks.
    invoke<AppUpdate>("app_update_offer")
      .then((offer) => {
        if (current)
          setUpdatesItself(
            typeof offer.updatesItself === "boolean"
              ? offer.updatesItself
              : "unknown",
          );
      })
      .catch(() => {
        if (current) setUpdatesItself("unknown");
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!installing) return;
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
  }, [installing]);

  // A newer version found goes on getting ready after the check: asked again until it is.
  const found = checked?.found === "available";
  useEffect(() => {
    if (!found || ready?.state === "ready") return;
    let current = true;
    const ask = async () => {
      try {
        const offer = await invoke<AppUpdate>("app_update_offer");
        if (current && offer.ready) setReady(offer.ready);
      } catch {
        // How ready it is is a courtesy. The check already said it is there.
      }
    };
    const timer = setInterval(() => void ask(), READY_EVERY_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [found, ready?.state]);

  async function check() {
    setChecking(true);
    setFailure(null);
    setInstallFailure(null);
    try {
      setChecked(await invoke<Checked>("check_app_update"));
    } catch (error) {
      setChecked(null);
      setFailure(asProblem(error));
    } finally {
      setChecking(false);
    }
  }

  async function install() {
    setInstalling(true);
    setInstallFailure(null);
    try {
      // Returns only when it failed: on success the app restarts into the new version.
      await invoke("install_app_update");
    } catch (error) {
      setInstallFailure(asProblem(error).said);
      setInstalling(false);
      setProgress(null);
    }
  }

  if (updatesItself === false) {
    return (
      <details>
        <summary>Updates</summary>
        <p>{DOESNT_UPDATE_ITSELF}</p>
      </details>
    );
  }

  return (
    <details>
      <summary>Updates</summary>
      {updatesItself === true && (
        <p>
          OpenBot updates itself with signed updates from its publisher. The
          next Start after an update brings this installation to the same
          version and keeps your data.
        </p>
      )}
      <button
        type="button"
        className="quiet"
        disabled={checking || installing}
        onClick={() => void check()}
      >
        {checking ? "Checking…" : "Check for updates"}
      </button>
      {checked?.found === "available" && (
        <>
          <p role="status">
            {updateOffered(checked.version, ready ?? checked.ready)} You are
            running {checked.current}.
          </p>
          <button
            type="button"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? describe(progress) : "Update and restart"}
          </button>
          {installFailure && (
            <p className="caution" role="alert">
              OpenBot could not install the update: {installFailure}
            </p>
          )}
        </>
      )}
      {checked?.found === "upToDate" && (
        <p role="status">OpenBot {checked.current} is up to date.</p>
      )}
      {checked?.found === "installing" && (
        <p role="status">
          OpenBot is downloading {checked.version} and restarts when it's done.
        </p>
      )}
      {checked?.found === "notOffered" && (
        <p role="status">{DOESNT_UPDATE_ITSELF}</p>
      )}
      {failure && <InlineFailure problem={failure} />}
    </details>
  );
}
