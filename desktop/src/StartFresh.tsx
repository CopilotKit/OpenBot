/**
 * Only rendered when native setup has identified leftover data it can remove.
 *
 * A choice, not a failure. Somebody whose previous installation left data most likely deleted its
 * folder to start over, so starting fresh is the main action and it carries on into Start. Keeping
 * the data means restoring that folder, which this window cannot do for them, so it is explained
 * rather than offered as a button.
 */
export function StartFresh({
  busy,
  containers,
  database,
  onStartFresh,
  volumes,
}: {
  busy: boolean;
  /** Stopped containers that still hold the volumes. Starting fresh removes them first. */
  containers: string[];
  /** Whether the local OpenBot database is one of the volumes. */
  database: boolean;
  /** Exactly the volumes native setup verified, and the only ones starting fresh removes. */
  volumes: string[];
  onStartFresh: (volumes: string[], containers: string[]) => Promise<void>;
}) {
  const others = volumes.length > (database ? 1 : 0);
  const left =
    database && others
      ? "its database of saved chats, Bots, and settings, and its Bot files and browser sign-ins"
      : database
        ? "its database of saved chats, Bots, and settings"
        : "its Bot files and browser sign-ins";
  return (
    <section className="blocker" aria-labelledby="start-fresh-title">
      <h2 id="start-fresh-title">
        A previous OpenBot installation left data here
      </h2>
      <p>
        It includes {left}. A new installation does not reuse it. Start fresh
        permanently deletes that data, then starts OpenBot.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={busy}
          onClick={() => onStartFresh(volumes, containers)}
        >
          {busy ? "Starting fresh…" : "Start fresh"}
        </button>
      </div>
      <p className="footnote">
        To keep that data instead, do not start. Restore the previous
        installation’s folder
        {database ? ", with its original encryption key," : ""} and choose it
        under Installation options.
      </p>
      <details>
        <summary>What Start fresh deletes</summary>
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
      </details>
    </section>
  );
}
