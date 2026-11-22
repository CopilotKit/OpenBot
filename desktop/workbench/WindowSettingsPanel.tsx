import { useId, useState } from "react";
import { MIN_WINDOW } from "./urlState";

export type WindowSettingsValue = {
  width: number;
  height: number;
  os: "mac" | "windows";
  active: boolean;
  theme: "light" | "dark";
  zoom: number;
  grid: boolean;
};

/** The app frame's settings: who hosts it, who is signed in, and the motion. */
export type AppWindowSettings = {
  host: "desktop" | "browser";
  role: "member" | "admin" | "owner" | null;
  motion: "still" | "real";
};

export type WindowSettingsPanelProps = {
  value: WindowSettingsValue;
  gridColor: string;
  onChange(patch: Partial<WindowSettingsValue>): void;
  onGridColor(color: string): void;
  onCopyLink(): void;
  /**
   * Fit: the window is zoomed to fit the stage. `zoom` is the zoom that fits now. Without it the
   * panel has no Fit button.
   */
  fit?: { on: boolean; zoom: number };
  onFit?(on: boolean): void;
  /** Set for an app scene: shows the App fields. */
  app?: AppWindowSettings;
  onAppChange?(patch: Partial<AppWindowSettings>): void;
};

/** The select value for "As the scene says" (role null). */
const SCENE_ROLE = "scene";

function toRole(value: string): AppWindowSettings["role"] {
  return value === "member" || value === "admin" || value === "owner"
    ? value
    : null;
}

function AppFields(props: {
  app: AppWindowSettings;
  onAppChange?(patch: Partial<AppWindowSettings>): void;
}) {
  const { app } = props;
  return (
    <>
      <h3>App</h3>
      <label className="wb-prop">
        <span>Host</span>
        <select
          value={app.host}
          onChange={(event) =>
            props.onAppChange?.({
              host: event.target.value === "browser" ? "browser" : "desktop",
            })
          }
        >
          <option value="desktop">OpenBot Desktop</option>
          <option value="browser">Browser</option>
        </select>
      </label>
      <label className="wb-prop">
        <span>Signed in as</span>
        <select
          value={app.role ?? SCENE_ROLE}
          onChange={(event) =>
            props.onAppChange?.({ role: toRole(event.target.value) })
          }
        >
          <option value={SCENE_ROLE}>As the scene says</option>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
      </label>
      <label className="wb-prop">
        <span>Motion</span>
        <select
          value={app.motion}
          onChange={(event) =>
            props.onAppChange?.({
              motion: event.target.value === "real" ? "real" : "still",
            })
          }
        >
          <option value="still">Still</option>
          <option value="real">Real</option>
        </select>
      </label>
    </>
  );
}

// The smallest window the address can hold (urlState.ts clamps to the same).
const MIN_WIDTH = MIN_WINDOW.width;
const MIN_HEIGHT = MIN_WINDOW.height;

function SizeInput(props: {
  label: string;
  id?: string;
  min: number;
  max?: number;
  step?: number;
  value: number;
  onNumber(value: number): void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      id={props.id}
      type="number"
      aria-label={props.id ? undefined : props.label}
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
  );
}

export function WindowSettingsPanel(props: WindowSettingsPanelProps) {
  const { value, fit } = props;
  const ids = useId();
  const zoomId = `${ids}-zoom`;
  const gridId = `${ids}-grid`;
  const fitOn = fit?.on === true;
  const shownZoom =
    fitOn && fit ? Math.round(fit.zoom * 100) / 100 : value.zoom;
  return (
    <section className="wb-window-panel">
      <h2>Window</h2>
      <div className="wb-presets">
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
      <div className="wb-prop">
        <span>Size</span>
        <div className="wb-size">
          <SizeInput
            label="Width"
            min={MIN_WIDTH}
            value={value.width}
            onNumber={(width) => props.onChange({ width })}
          />
          <span aria-hidden="true">×</span>
          <SizeInput
            label="Height"
            min={MIN_HEIGHT}
            value={value.height}
            onNumber={(height) => props.onChange({ height })}
          />
        </div>
      </div>
      <div className="wb-prop">
        <label htmlFor={zoomId}>Zoom</label>
        <div className="wb-inline">
          <SizeInput
            // A new fit value shows at once; a typed value stays while the field has the focus.
            key={fitOn ? `fit-${shownZoom}` : "zoom"}
            label="Zoom"
            id={zoomId}
            min={0.5}
            max={2}
            step={0.1}
            value={shownZoom}
            onNumber={(zoom) => props.onChange({ zoom })}
          />
          {props.onFit && fit && (
            <button
              type="button"
              aria-pressed={fitOn}
              title="Zoom the window to fit the space"
              onClick={() => props.onFit?.(!fitOn)}
            >
              {fitOn ? `Fit (${Math.round(fit.zoom * 100)}%)` : "Fit"}
            </button>
          )}
        </div>
      </div>
      <label className="wb-prop">
        <span>OS</span>
        <select
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
      </label>
      <label className="wb-prop">
        <span>Theme</span>
        <select
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
      </label>
      <label className="wb-prop">
        <span>Active</span>
        <input
          type="checkbox"
          checked={value.active}
          onChange={(event) => props.onChange({ active: event.target.checked })}
        />
      </label>
      <div className="wb-prop">
        <label htmlFor={gridId}>Grid</label>
        <div className="wb-inline">
          <input
            id={gridId}
            type="checkbox"
            checked={value.grid}
            onChange={(event) => props.onChange({ grid: event.target.checked })}
          />
          <input
            type="color"
            aria-label="Grid color"
            title="Grid color"
            value={props.gridColor}
            onChange={(event) => props.onGridColor(event.target.value)}
          />
        </div>
      </div>
      <div className="wb-presets">
        <button type="button" onClick={props.onCopyLink}>
          Copy link
        </button>
      </div>
      {props.app && (
        <AppFields app={props.app} onAppChange={props.onAppChange} />
      )}
    </section>
  );
}
