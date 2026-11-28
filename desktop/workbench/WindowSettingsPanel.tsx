import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  APP_SIDEBARS,
  APP_SKINS,
  type AppSidebar,
  type AppSkin,
} from "./appContract";
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

/** The app frame's settings: who hosts it, who is signed in, the motion, the skin and the sidebar. */
export type AppWindowSettings = {
  host: "desktop" | "browser";
  role: "member" | "admin" | "owner" | null;
  /** null: as the scene says. */
  skin: AppSkin | null;
  /** null: as the scene says. */
  sidebar: AppSidebar | null;
};

/** The words for each skin in the Skin select. */
const SKIN_LABELS: Record<AppSkin, string> = {
  openbot: "OpenBot",
  openduet: "OpenDuet",
  opendots: "OpenDots",
  openfuse: "OpenFuse",
};

/** What the pointer does over the app when Comment is off. */
export type SelectMode = "inspect" | "off";

const SELECT_MODES: readonly Option[] = [
  { value: "inspect", label: "Inspect" },
  { value: "off", label: "Off" },
];

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
  /**
   * Select mode: Inspect outlines the element under the pointer, Off draws nothing so the pointer
   * just clicks through. Without onSelectMode the panel has no Select mode row.
   */
  selectMode?: SelectMode;
  onSelectMode?(mode: SelectMode): void;
};

/** The select value for "Preset default" (role null). */
const SCENE_ROLE = "scene";

function toRole(value: string): AppWindowSettings["role"] {
  return value === "member" || value === "admin" || value === "owner"
    ? value
    : null;
}

/** A row: the name on the left, the control on the right. */
const ROW = "grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2 px-1";
const ROW_LABEL = "text-xs font-normal text-muted-foreground";

type Option = { value: string; label: string };

/** One row with a label and a Select. The trigger shows the label of the value. */
function SelectRow(props: {
  label: string;
  value: string;
  options: readonly Option[];
  onValue(value: string): void;
}) {
  const id = useId();
  const shown = props.options.find((o) => o.value === props.value)?.label;
  return (
    <Field orientation="horizontal" className={ROW}>
      <FieldLabel htmlFor={id} className={ROW_LABEL}>
        {props.label}
      </FieldLabel>
      <Select
        value={props.value}
        onValueChange={(value) => props.onValue(String(value))}
      >
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue>{shown}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

const HOSTS: readonly Option[] = [
  { value: "desktop", label: "OpenBot Desktop" },
  { value: "browser", label: "Browser" },
];

const ROLES: readonly Option[] = [
  { value: SCENE_ROLE, label: "Preset default" },
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

const SKINS: readonly Option[] = [
  { value: SCENE_ROLE, label: "Preset default" },
  ...APP_SKINS.map((skin) => ({ value: skin, label: SKIN_LABELS[skin] })),
];

const SIDEBARS: readonly Option[] = [
  { value: SCENE_ROLE, label: "Preset default" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
];

const OSES: readonly Option[] = [
  { value: "mac", label: "Mac" },
  { value: "windows", label: "Windows" },
];

const THEMES: readonly Option[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppFields(props: {
  app: AppWindowSettings;
  onAppChange?(patch: Partial<AppWindowSettings>): void;
}) {
  const { app } = props;
  return (
    <>
      <h3 className="pt-2 text-sm font-medium">App</h3>
      <SelectRow
        label="Host"
        value={app.host}
        options={HOSTS}
        onValue={(value) =>
          props.onAppChange?.({
            host: value === "browser" ? "browser" : "desktop",
          })
        }
      />
      <SelectRow
        label="Signed in as"
        value={app.role ?? SCENE_ROLE}
        options={ROLES}
        onValue={(value) => props.onAppChange?.({ role: toRole(value) })}
      />
      <SelectRow
        label="Skin"
        value={app.skin ?? SCENE_ROLE}
        options={SKINS}
        onValue={(value) =>
          props.onAppChange?.({
            skin: APP_SKINS.find((s) => s === value) ?? null,
          })
        }
      />
      <SelectRow
        label="Sidebar"
        value={app.sidebar ?? SCENE_ROLE}
        options={SIDEBARS}
        onValue={(value) =>
          props.onAppChange?.({
            sidebar: APP_SIDEBARS.find((s) => s === value) ?? null,
          })
        }
      />
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
  className?: string;
  value: number;
  onNumber(value: number): void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      id={props.id}
      type="number"
      className={props.className}
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
  const activeId = `${ids}-active`;
  const gridId = `${ids}-grid`;
  const fitOn = fit?.on === true;
  const shownZoom =
    fitOn && fit ? Math.round(fit.zoom * 100) / 100 : value.zoom;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Window</h2>
      <div className="flex flex-wrap gap-2 px-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onChange({ width: 1000, height: 800 })}
        >
          1000 × 800
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onChange({ width: 720, height: 560 })}
        >
          720 × 560
        </Button>
      </div>
      <Field orientation="horizontal" className={ROW}>
        <FieldTitle className={ROW_LABEL}>Size</FieldTitle>
        <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <SizeInput
            label="Width"
            className="h-7 min-w-0 flex-1 px-2"
            min={MIN_WIDTH}
            value={value.width}
            onNumber={(width) => props.onChange({ width })}
          />
          <span aria-hidden="true">×</span>
          <SizeInput
            label="Height"
            className="h-7 min-w-0 flex-1 px-2"
            min={MIN_HEIGHT}
            value={value.height}
            onNumber={(height) => props.onChange({ height })}
          />
        </div>
      </Field>
      <Field orientation="horizontal" className={ROW}>
        <FieldLabel htmlFor={zoomId} className={ROW_LABEL}>
          Zoom
        </FieldLabel>
        {/* In a narrow column Fit goes under the field, so the field still shows a zoom like 0.95. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SizeInput
            // A new fit value shows at once; a typed value stays while the field has the focus.
            key={fitOn ? `fit-${shownZoom}` : "zoom"}
            label="Zoom"
            id={zoomId}
            className="h-7 max-w-24 min-w-16 grow basis-16 px-2"
            min={0.5}
            max={2}
            step={0.1}
            value={shownZoom}
            onNumber={(zoom) => props.onChange({ zoom })}
          />
          {props.onFit && fit && (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={fitOn}
              // Pressed looks like the outline button's open state.
              className="aria-pressed:bg-muted aria-pressed:text-foreground"
              title="Zoom the window to fit the space"
              onClick={() => props.onFit?.(!fitOn)}
            >
              {fitOn ? `Fit (${Math.round(fit.zoom * 100)}%)` : "Fit"}
            </Button>
          )}
        </div>
      </Field>
      <SelectRow
        label="OS"
        value={value.os}
        options={OSES}
        onValue={(os) =>
          props.onChange({ os: os === "windows" ? "windows" : "mac" })
        }
      />
      <SelectRow
        label="Theme"
        value={value.theme}
        options={THEMES}
        onValue={(theme) =>
          props.onChange({ theme: theme === "dark" ? "dark" : "light" })
        }
      />
      <Field orientation="horizontal" className={ROW}>
        <FieldLabel htmlFor={activeId} className={ROW_LABEL}>
          Active
        </FieldLabel>
        <Checkbox
          id={activeId}
          checked={value.active}
          onCheckedChange={(active) => props.onChange({ active })}
        />
      </Field>
      <Field orientation="horizontal" className={ROW}>
        <FieldLabel htmlFor={gridId} className={ROW_LABEL}>
          Grid
        </FieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Checkbox
            id={gridId}
            checked={value.grid}
            onCheckedChange={(grid) => props.onChange({ grid })}
          />
          <Input
            type="color"
            aria-label="Grid color"
            title="Grid color"
            className="h-7 w-10 p-0.5"
            value={props.gridColor}
            onChange={(event) => props.onGridColor(event.target.value)}
          />
        </div>
      </Field>
      {props.onSelectMode && (
        <SelectRow
          label="Select mode"
          value={props.selectMode ?? "inspect"}
          options={SELECT_MODES}
          onValue={(mode) =>
            props.onSelectMode?.(mode === "off" ? "off" : "inspect")
          }
        />
      )}
      <div className="flex flex-wrap gap-2 px-1">
        <Button variant="outline" size="sm" onClick={props.onCopyLink}>
          Copy link
        </Button>
      </div>
      {props.app && (
        <AppFields app={props.app} onAppChange={props.onAppChange} />
      )}
    </section>
  );
}
