import { useCallback, useRef, useState } from "react";
import { COMMANDS } from "../src/fakeNative/registry";
import { type FrameConfig, frameUrl } from "./frameConfig";
import { SceneList } from "./SceneList";
import { SCENES } from "./scenes";
import { decodeState, encodeState, type WorkbenchState } from "./urlState";
import { WindowFrame } from "./WindowFrame";
import {
  WindowSettingsPanel,
  type WindowSettingsValue,
} from "./WindowSettingsPanel";

// The grid color is page state and not in the URL. A color input takes only #rrggbb.
const DEFAULT_GRID_COLOR = "#ff00ff";

function initial(): { state: WorkbenchState; notices: string[] } {
  return decodeState(window.location.search, SCENES, COMMANDS);
}

/** The frame reads this object when it boots, so it is set before the iframe mounts. */
function frameConfig(state: WorkbenchState): FrameConfig {
  const scene = SCENES.find((s) => s.id === state.scene) ?? SCENES[0];
  return {
    hash: scene?.start.hash ?? "",
    search: scene?.start.search ?? "",
    os: state.window.os,
    env: { ...scene?.start.env, ...state.env },
    answers: { ...scene?.start.answers, ...state.answers },
    theme: state.window.theme,
  };
}

export function Workbench() {
  const [boot] = useState(initial);
  const [state, setState] = useState<WorkbenchState>(boot.state);
  const [notices, setNotices] = useState<string[]>(boot.notices);
  const [gridColor, setGridColor] = useState(DEFAULT_GRID_COLOR);
  const [remountCount] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const update = useCallback(
    (next: WorkbenchState | ((prev: WorkbenchState) => WorkbenchState)) => {
      setState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        window.history.replaceState(null, "", `?${encodeState(value)}`);
        return value;
      });
    },
    [],
  );

  const config = frameConfig(state);
  // Set during render, before the iframe element mounts and starts to load.
  window.__workbenchFrame = config;
  const frameKey = `${state.scene}|${state.window.os}|${JSON.stringify(config.env)}|${remountCount}`;

  const pickScene = (id: string) => {
    const scene = SCENES.find((s) => s.id === id);
    update((prev) => ({
      ...prev,
      scene: id,
      at: 0,
      answers: {},
      window: { ...prev.window, os: scene?.start.os ?? prev.window.os },
    }));
  };

  const changeWindow = (patch: Partial<WindowSettingsValue>) => {
    update((prev) => ({ ...prev, window: { ...prev.window, ...patch } }));
    if (patch.theme) {
      const win = frameRef.current?.contentWindow as
        | (Window & typeof globalThis)
        | null
        | undefined;
      win?.__workbenchSetTheme?.(patch.theme);
    }
  };

  return (
    <div className="wb-page">
      <aside className="wb-side wb-side-left">
        <SceneList scenes={SCENES} current={state.scene} onPick={pickScene} />
      </aside>
      <main className="wb-center">
        {notices.length > 0 && (
          <div className="wb-notices">
            {notices.map((text, index) => (
              <div
                // A notice has no id, and the list only shrinks.
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
                key={`${index}|${text}`}
                className="wb-notice"
                role="status"
              >
                <span>{text}</span>
                <button
                  type="button"
                  onClick={() =>
                    setNotices((all) => all.filter((_, i) => i !== index))
                  }
                >
                  Close
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="wb-stage">
          <WindowFrame
            src={frameUrl(config)}
            frameKey={frameKey}
            width={state.window.width}
            height={state.window.height}
            os={state.window.os}
            active={state.window.active}
            theme={state.window.theme}
            zoom={state.window.zoom}
            grid={state.window.grid}
            gridColor={gridColor}
            onFrame={(iframe) => {
              frameRef.current = iframe;
            }}
          />
        </div>
        <div className="wb-under" />
      </main>
      <aside className="wb-side wb-side-right">
        <WindowSettingsPanel
          value={state.window}
          gridColor={gridColor}
          onChange={changeWindow}
          onGridColor={setGridColor}
          onCopyLink={() => {
            void navigator.clipboard.writeText(window.location.href);
          }}
        />
      </aside>
    </div>
  );
}
