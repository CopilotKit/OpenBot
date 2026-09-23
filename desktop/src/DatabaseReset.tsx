import { useState } from "react";

/** Only rendered when native setup has identified a recoverable leftover database. */
export function DatabaseReset({
  busy,
  onReset,
  volume,
}: {
  busy: boolean;
  volume: string;
  onReset: (volume: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="quiet"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        Reset leftover database
      </button>
    );
  }
  return (
    <section className="blocker" aria-labelledby="database-reset-title">
      <h2 id="database-reset-title">
        Delete the previous installation’s data?
      </h2>
      <p>
        This permanently deletes the local OpenBot database, including saved
        chats, Bots, and settings. Only continue if you want a fresh
        installation and do not need that data.
      </p>
      <p>To keep your data, restore its original encryption key instead.</p>
      <div className="row">
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Keep saved data
        </button>
        <button type="button" disabled={busy} onClick={() => onReset(volume)}>
          {busy ? "Deleting saved data…" : "Delete saved data"}
        </button>
      </div>
    </section>
  );
}
