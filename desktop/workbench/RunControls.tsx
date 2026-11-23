import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

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
  const label = SPEEDS.find((option) => option.value === String(speed))?.label;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          aria-keyshortcuts="Space"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          onClick={playing ? props.onPause : props.onPlay}
        >
          {playing ? "Pause" : "Play"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-keyshortcuts="."
          title="Step to the next run step (.)"
          onClick={props.onStep}
        >
          Step
        </Button>
        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{`${formatTime(now)} / ${formatTime(end)}`}</span>
      </div>
      <div className="relative pb-2">
        <Slider
          thumbLabel="Time"
          aria-keyshortcuts="ArrowLeft ArrowRight"
          min={0}
          max={Math.max(end, 1)}
          step={100}
          value={now}
          onValueChange={(value) =>
            props.onSeek(Array.isArray(value) ? value[0] : value)
          }
        />
        {/* Inset by the thumb's radius, so 0% and 100% sit under the thumb's centre. */}
        <div
          className="pointer-events-none absolute inset-x-2 bottom-0 h-1.5"
          aria-hidden="true"
        >
          {end > 0 &&
            marks.map((mark, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: marks can repeat, and the list has no other identity
                key={`${index}-${mark}`}
                data-testid="mark"
                className="absolute top-0 h-full w-px bg-muted-foreground"
                style={{ left: `${Math.min(100, (mark / end) * 100)}%` }}
              />
            ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Speed</span>
        <Select
          value={String(speed)}
          onValueChange={(value) => props.onSpeed(parseSpeed(String(value)))}
        >
          <SelectTrigger size="sm" aria-label="Speed" className="min-w-20">
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SPEEDS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {props.onPauseAtActions && (
        <Label className="text-xs font-normal">
          <Checkbox
            checked={props.pauseAtActions ?? false}
            onCheckedChange={(checked) => props.onPauseAtActions?.(checked)}
          />
          Pause at each action
        </Label>
      )}
      {props.next && (
        <p
          className="text-xs text-muted-foreground"
          role="status"
        >{`Next: ${props.next}`}</p>
      )}
    </div>
  );
}
