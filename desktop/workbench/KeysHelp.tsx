/** The page's keys, as the "?" button shows them. Workbench.tsx handles them. */
export const KEYS: readonly { keys: string[]; what: string }[] = [
  { keys: ["/"], what: "Filter the scenes" },
  { keys: ["↑", "↓"], what: "Move between scenes" },
  { keys: ["Enter"], what: "Open the scene" },
  { keys: ["Space"], what: "Play or pause" },
  { keys: ["."], what: "Step to the next run step" },
  { keys: ["←", "→"], what: "Seek 1 second back or on" },
  { keys: ["C"], what: "Comment mode on or off" },
];

/** A "?" button that folds open the list of keys. */
export function KeysHelp() {
  return (
    <details className="wb-keys">
      <summary aria-label="Keys" title="Keys">
        ?
      </summary>
      <div className="wb-keys-card">
        <h3>Keys</h3>
        <dl>
          {KEYS.map((row) => (
            <div key={row.what}>
              <dt>
                {row.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </dt>
              <dd>{row.what}</dd>
            </div>
          ))}
        </dl>
        <p>The keys do nothing while you type in a field.</p>
      </div>
    </details>
  );
}
