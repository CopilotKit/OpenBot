export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, "0")}`;
}

export type Speed = 0.25 | 0.5 | 1 | 10 | "max";

export type RunControlsProps = {
  now: number;
  end: number;
  marks: readonly number[];
  playing: boolean;
  speed: Speed;
  onPlay(): void;
  onPause(): void;
  onStep(): void;
  onSeek(ms: number): void;
  onSpeed(speed: Speed): void;
  /** "Pause at each action": playback stops just before each click and type step. */
  pauseAtActions?: boolean;
  onPauseAtActions?(on: boolean): void;
  /** The action the run stopped before, as "Click · Install", or null. */
  next?: string | null;
};

const SPEEDS: { value: string; label: string }[] = [
  { value: "0.25", label: "¼×" },
  { value: "0.5", label: "½×" },
  { value: "1", label: "1×" },
  { value: "10", label: "10×" },
  { value: "max", label: "Max" },
];

/** A speed from its option value; anything it does not know is 1×. */
export function parseSpeed(value: string): Speed {
  switch (value) {
    case "max":
      return "max";
    case "10":
      return 10;
    case "0.5":
      return 0.5;
    case "0.25":
      return 0.25;
    default:
      return 1;
  }
}

export function RunControls(props: RunControlsProps) {
  const { now, end, marks, playing, speed } = props;
  return (
    <div>
      <button type="button" onClick={playing ? props.onPause : props.onPlay}>
        {playing ? "Pause" : "Play"}
      </button>
      <button type="button" onClick={props.onStep}>
        Step
      </button>
      <div style={{ position: "relative" }}>
        <input
          type="range"
          aria-label="Time"
          min={0}
          max={end}
          step={100}
          value={now}
          onChange={(event) => props.onSeek(Number(event.target.value))}
        />
        {end > 0 &&
          marks.map((mark, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: marks can repeat, and the list has no other identity
              key={`${index}-${mark}`}
              data-testid="mark"
              style={{
                position: "absolute",
                left: `${(mark / end) * 100}%`,
                top: 0,
                width: 1,
                height: "100%",
                background: "currentColor",
                pointerEvents: "none",
              }}
            />
          ))}
      </div>
      <select
        aria-label="Speed"
        value={String(speed)}
        onChange={(event) => props.onSpeed(parseSpeed(event.target.value))}
      >
        {SPEEDS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span>{`${formatTime(now)} / ${formatTime(end)}`}</span>
      {props.onPauseAtActions && (
        <label className="wb-pause-at-actions">
          <input
            type="checkbox"
            checked={props.pauseAtActions ?? false}
            onChange={(event) => props.onPauseAtActions?.(event.target.checked)}
          />
          Pause at each action
        </label>
      )}
      {props.next && (
        <p className="wb-next-action" role="status">{`Next: ${props.next}`}</p>
      )}
    </div>
  );
}
