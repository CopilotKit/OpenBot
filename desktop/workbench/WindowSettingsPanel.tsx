import { useState } from "react";

export type WindowSettingsValue = {
  width: number;
  height: number;
  os: "mac" | "windows";
  active: boolean;
  theme: "light" | "dark";
  zoom: number;
  grid: boolean;
};

export type WindowSettingsPanelProps = {
  value: WindowSettingsValue;
  gridColor: string;
  onChange(patch: Partial<WindowSettingsValue>): void;
  onGridColor(color: string): void;
  onCopyLink(): void;
};

const MIN_WIDTH = 720;
const MIN_HEIGHT = 560;

function SizeInput(props: {
  label: string;
  min: number;
  max?: number;
  step?: number;
  value: number;
  onNumber(value: number): void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label>
      {props.label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={text ?? String(props.value)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const number = Number(next);
          if (
            next !== "" &&
            Number.isFinite(number) &&
            number >= props.min &&
            (props.max === undefined || number <= props.max)
          ) {
            props.onNumber(number);
          }
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}

export function WindowSettingsPanel(props: WindowSettingsPanelProps) {
  const { value } = props;
  return (
    <section>
      <h2>Window</h2>
      <div>
        <button
          type="button"
          onClick={() => props.onChange({ width: 1000, height: 800 })}
        >
          1000 × 800
        </button>
        <button
          type="button"
          onClick={() => props.onChange({ width: 720, height: 560 })}
        >
          720 × 560
        </button>
      </div>
      <SizeInput
        label="Width"
        min={MIN_WIDTH}
        value={value.width}
        onNumber={(width) => props.onChange({ width })}
      />
      <SizeInput
        label="Height"
        min={MIN_HEIGHT}
        value={value.height}
        onNumber={(height) => props.onChange({ height })}
      />
      <select
        aria-label="OS"
        value={value.os}
        onChange={(event) =>
          props.onChange({
            os: event.target.value === "windows" ? "windows" : "mac",
          })
        }
      >
        <option value="mac">Mac</option>
        <option value="windows">Windows</option>
      </select>
      <label>
        <input
          type="checkbox"
          checked={value.active}
          onChange={(event) => props.onChange({ active: event.target.checked })}
        />
        Active
      </label>
      <select
        aria-label="Theme"
        value={value.theme}
        onChange={(event) =>
          props.onChange({
            theme: event.target.value === "dark" ? "dark" : "light",
          })
        }
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <SizeInput
        label="Zoom"
        min={0.5}
        max={2}
        step={0.1}
        value={value.zoom}
        onNumber={(zoom) => props.onChange({ zoom })}
      />
      <label>
        <input
          type="checkbox"
          checked={value.grid}
          onChange={(event) => props.onChange({ grid: event.target.checked })}
        />
        Grid
      </label>
      <input
        type="color"
        aria-label="Grid color"
        value={props.gridColor}
        onChange={(event) => props.onGridColor(event.target.value)}
      />
      <button type="button" onClick={props.onCopyLink}>
        Copy link
      </button>
    </section>
  );
}
