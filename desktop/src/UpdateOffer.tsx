import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";

/**
 * The one screen that is not part of setup: a newer OpenBot exists, install it.
 *
 * Asked once, at launch, and never again in that run. An app that installs itself without saying
 * so restarts in the middle of somebody's sentence, and an app that asks on a timer is a dialogue
 * box that keeps coming back; so the offer appears once and stays until it is answered or the
 * window is closed.
 *
 * A failed check is silent. The endpoint can be unreachable because the machine is on a plane, on
 * a captive portal, or behind a proxy that does not like it, and none of those are things the
 * person opening the setup window can do anything about. A build that is not signed has no updater
 * registered at all, and its check is refused the same way and just as quietly. A failed *install*
 * is not silent: by then
 * they asked for something and it did not happen.
 *
 * Nothing here decides whether the download is genuine. `tauri-plugin-updater` verifies the
 * minisign signature published beside each artifact against the public key compiled into the app,
 * and refuses the bundle if it does not match, so a hijacked endpoint serves something that will
 * not install rather than something that will.
 */
export function UpdateOffer() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const found = await check();
        if (current && found) setUpdate(found);
      } catch {
        // See above: a check that could not run is not news.
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    setFailure(null);
    setDownloaded(0);
    setTotal(null);
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started")
          setTotal(event.data.contentLength ?? null);
        else if (event.event === "Progress")
          setDownloaded((soFar) => soFar + event.data.chunkLength);
      });
      // The update is written but the running process is still the old one. Restarting is the
      // second half of installing, so it is not offered as a separate button to forget to press.
      await relaunch();
    } catch (error) {
      setInstalling(false);
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [update]);

  if (!update || dismissed) return null;

  return (
    <section className="update-offer" aria-labelledby="update-offer-title">
      <h2 id="update-offer-title">OpenBot {update.version} is available</h2>
      <p>
        You are running {update.currentVersion}. Updating downloads the new
        version and restarts OpenBot.
      </p>
      <div className="row">
        <button type="button" disabled={installing} onClick={install}>
          {installing ? progress(downloaded, total) : "Update and restart"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={installing}
          onClick={() => setDismissed(true)}
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

function progress(downloaded: number, total: number | null): string {
  if (!total) return "Downloading…";
  return `Downloading… ${Math.min(100, Math.round((downloaded / total) * 100))}%`;
}
