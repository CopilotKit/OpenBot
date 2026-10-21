import { useState } from "react";

/** Only rendered when native setup has identified leftover data it can reset. */
export function DatabaseReset({
  busy,
  containers,
  database,
  onReset,
  volumes,
}: {
  busy: boolean;
  /** Stopped containers that still hold the volumes. The reset removes them first. */
  containers: string[];
  /** Whether the local OpenBot database is one of the volumes. */
  database: boolean;
  /** Exactly the volumes native setup verified, and the only ones a reset removes. */
  volumes: string[];
  onReset: (volumes: string[], containers: string[]) => Promise<void>;
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
        {database ? "Reset leftover database" : "Reset leftover data"}
      </button>
    );
  }
  const others = volumes.length > (database ? 1 : 0);
  return (
    <section className="blocker" aria-labelledby="database-reset-title">
      <h2 id="database-reset-title">
        Delete the previous installation’s data?
      </h2>
      {database && (
        <p>
          This permanently deletes the local OpenBot database, including saved
          chats, Bots, and settings.
        </p>
      )}
      {others && (
        <p>
          {database
            ? "It also permanently deletes other data it left, including Bot files and browser sign-ins."
            : "This permanently deletes data the previous installation left, including Bot files and browser sign-ins."}
        </p>
      )}
      <p>
        Only continue if you want a fresh installation and do not need that
        data. OpenBot deletes these volumes:
      </p>
      <ul>
        {volumes.map((volume) => (
          <li key={volume}>
            <code>{volume}</code>
          </li>
        ))}
      </ul>
      {containers.length > 0 && (
        <>
          <p>
            It first removes these stopped containers from the previous
            installation, which still use those volumes:
          </p>
          <ul>
            {containers.map((container) => (
              <li key={container}>
                <code>{container}</code>
              </li>
            ))}
          </ul>
        </>
      )}
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
        <button
          type="button"
          disabled={busy}
          onClick={() => onReset(volumes, containers)}
        >
          {busy ? "Deleting saved data…" : "Delete saved data"}
        </button>
      </div>
    </section>
  );
}
