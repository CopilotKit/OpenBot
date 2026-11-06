import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { asProblem } from "./Problem";

/**
 * What the shell offers. The same answer OpenBot's own page reads for its update banner, so the
 * setup window and the app never offer two different things, and closing one closes both.
 */
export type AppUpdate = {
  /** The version to offer; null when there is none, or the person closed the offer on it. */
  version: string | null;
  /** This app's own version. */
  current: string;
  installing: {
    downloaded: number;
    total: number | null;
    restarting: boolean;
  } | null;
};

/**
 * How often the window asks the shell again. The shell reads the update feed itself, at launch and
 * every six hours (`app_update.rs`), so asking it is a read of memory, not of the network.
 */
const ASK_EVERY_MS = 5_000;
const ASK_WHILE_INSTALLING_MS = 500;

/**
 * The one screen that is not part of setup: a newer OpenBot exists, install it.
 *
 * Nothing installs without the click. An app that installs itself without saying so restarts in
 * the middle of somebody's sentence. "Not now" closes the offer until a newer version comes out,
 * here and in OpenBot's own banner alike.
 *
 * A failed check is silent: the shell keeps its last good answer, and a laptop on a plane has
 * nothing to fix. A build without the updater (internal, candidate, unsigned) is never offered
 * anything. A failed *install* is not silent: by then they asked for something and it did not
 * happen.
 *
 * Nothing here decides whether the download is genuine. The updater verifies the minisign signature
 * published beside each archive against the public key compiled into the app, and refuses the
 * archive if it does not match.
 */
export function UpdateOffer() {
  const [offer, setOffer] = useState<AppUpdate | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const found = await invoke<AppUpdate>("app_update_offer");
        if (current) setOffer(found);
      } catch {
        // A shell with nothing to say is not news.
      }
      if (current)
        timer = setTimeout(
          ask,
          installing ? ASK_WHILE_INSTALLING_MS : ASK_EVERY_MS,
        );
    };
    void ask();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [installing]);

  const install = useCallback(async () => {
    setInstalling(true);
    setFailure(null);
    try {
      // Returns only when it failed: on success the app restarts into the new version.
      await invoke("install_app_update");
    } catch (error) {
      setInstalling(false);
      setFailure(asProblem(error).said);
    }
  }, []);

  const decline = useCallback(async (version: string) => {
    // Gone at once, and for the rest of this run even if it could not be remembered.
    setDeclined(version);
    try {
      await invoke("dismiss_app_update", { version });
    } catch {
      // Remembering it is a courtesy. The offer still went away when asked.
    }
  }, []);

  const version = offer?.version;
  if (!offer || !version || version === declined) return null;
  const progress = offer.installing;

  return (
    <section className="update-offer" aria-labelledby="update-offer-title">
      <h2 id="update-offer-title">OpenBot {version} is available</h2>
      <p>
        You are running {offer.current}. Updating downloads the new version and
        restarts OpenBot.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={installing || progress !== null}
          onClick={install}
        >
          {installing || progress !== null
            ? describe(progress)
            : "Update and restart"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={installing || progress !== null}
          onClick={() => void decline(version)}
        >
          Not now
        </button>
      </div>
      {failure && (
        <p className="caution" role="alert">
          OpenBot could not install the update: {failure}
        </p>
      )}
    </section>
  );
}

/** "Downloading… 25%", then "Restarting…" once it is installed. */
export function describe(progress: AppUpdate["installing"]): string {
  if (progress?.restarting) return "Restarting…";
  if (!progress?.total) return "Downloading…";
  return `Downloading… ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`;
}
