export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, "0")}`;
}

export type Speed = 1 | 10 | "max";

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
};

const SPEEDS: { value: string; label: string }[] = [
  { value: "1", label: "1×" },
  { value: "10", label: "10×" },
  { value: "max", label: "Max" },
];

function parseSpeed(value: string): Speed {
  return value === "max" ? "max" : value === "10" ? 10 : 1;
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
    </div>
  );
}
