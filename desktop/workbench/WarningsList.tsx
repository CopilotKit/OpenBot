import type { Warning } from "./layoutWatch";
import { formatTime } from "./RunControls";

export function warningText(warning: Warning): string {
  const when = formatTime(warning.at);
  switch (warning.kind) {
    case "moved":
      return `${warning.label} moved ${Math.round(Math.hypot(warning.dx, warning.dy))}px at ${when} (${warning.cause})`;
    case "clipped":
      return `${warning.label} is cut off at ${when}`;
    case "outside":
      return `${warning.label} is ${Math.round(warning.overBy)}px outside the window at ${when}`;
  }
}

export type WarningsListProps = {
  warnings: readonly Warning[];
  onSeek(ms: number): void;
};

export function WarningsList({ warnings, onSeek }: WarningsListProps) {
  const newestFirst = warnings
    .map((warning, index) => ({ warning, index }))
    .sort((a, b) => b.warning.at - a.warning.at || b.index - a.index);
  return (
    <section>
      <h3>{`Layout warnings (${warnings.length})`}</h3>
      {newestFirst.length === 0 ? (
        <p>No layout warnings.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {newestFirst.map(({ warning, index }) => (
            <li key={index}>
              <button type="button" onClick={() => onSeek(warning.at)}>
                {warningText(warning)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
