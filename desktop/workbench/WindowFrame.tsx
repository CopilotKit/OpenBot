import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CommentLayer, type CommentLayerProps } from "./CommentLayer";
import { GridOverlay } from "./GridOverlay";
import { Inspector } from "./Inspector";
import "./windowFrame.css";

export type WindowFrameProps = {
  src: string;
  frameKey: string;
  width: number;
  height: number;
  os: "mac" | "windows";
  active: boolean;
  theme: "light" | "dark";
  zoom: number;
  grid: boolean;
  gridColor: string;
  /** Who hosts the page: OpenBot Desktop (default) or a browser. */
  host?: "desktop" | "browser";
  /** The path the browser bar shows, for host "browser". Default "/". */
  address?: string;
  /** Comment mode: set, the comment layer replaces the inspector. */
  comment?: Omit<CommentLayerProps, "frame"> | null;
  /**
   * Drawn over the iframe and under the title bar, in the window's zoom and corners: the still of
   * the window while a warning hover seeks back.
   */
  cover?: ReactNode;
  onFrame?(iframe: HTMLIFrameElement | null): void;
};

const LIGHTS = ["#ff5f57", "#febc2e", "#28c840"];
const INACTIVE_LIGHT = "#8e8e93";

function MacBar({ active }: { active: boolean }) {
  return (
    <div className="wb-window-bar wb-window-bar-mac" aria-hidden="true">
      {LIGHTS.map((color, index) => (
        <span
          // The three lights never change order.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          key={index}
          className="wb-window-light"
          style={{ background: active ? color : INACTIVE_LIGHT }}
        />
      ))}
    </div>
  );
}

function WindowsBar({ active }: { active: boolean }) {
  return (
    <div
      className={`wb-window-bar wb-window-bar-windows${active ? "" : " wb-window-bar-inactive"}`}
      aria-hidden="true"
    >
      <span className="wb-window-title">OpenBot</span>
      <span className="wb-window-controls">
        <span className="wb-window-control">&#x2013;</span>
        <span className="wb-window-control">&#x25A1;</span>
        <span className="wb-window-control">&#x2715;</span>
      </span>
    </div>
  );
}

const BROWSER_ORIGIN = "http://localhost:3010";

function BrowserBar({ address }: { address: string }) {
  return (
    <div className="wb-window-bar wb-window-bar-browser" aria-hidden="true">
      <span className="wb-browser-dots">
        <span className="wb-browser-dot" />
        <span className="wb-browser-dot" />
        <span className="wb-browser-dot" />
      </span>
      <span className="wb-browser-address">{`${BROWSER_ORIGIN}${address}`}</span>
    </div>
  );
}

/** A window of the desktop app: the OS frame around an iframe of exact size, with the grid and the inspector (or the comment layer) over it. */
export function WindowFrame({
  src,
  frameKey,
  width,
  height,
  os,
  active,
  theme,
  zoom,
  grid,
  gridColor,
  host = "desktop",
  address,
  comment,
  cover,
  onFrame,
}: WindowFrameProps) {
  const browser = host === "browser";
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const ref = useRef<HTMLIFrameElement | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const setRef = useCallback((el: HTMLIFrameElement | null) => {
    ref.current = el;
    setFrame(el);
    // A new frameKey remounts only the iframe: the parent must drop the old one until the new one loads.
    if (el === null) onFrameRef.current?.(null);
  }, []);

  useEffect(
    () => () => {
      onFrameRef.current?.(null);
    },
    [],
  );

  return (
    <div
      data-workbench-window
      className={`wb-window wb-window-${os}`}
      style={{ zoom }}
    >
      {browser && <BrowserBar address={address ?? "/"} />}
      {!browser && os === "windows" && <WindowsBar active={active} />}
      <div className="wb-window-content" style={{ width, height }}>
        <iframe
          data-workbench-frame
          key={frameKey}
          ref={setRef}
          src={src}
          title="OpenBot window"
          onLoad={() => onFrameRef.current?.(ref.current)}
          style={{ width, height, border: 0, colorScheme: theme }}
        />
        {cover}
        {!browser && os === "mac" && <MacBar active={active} />}
        {grid && (
          <GridOverlay
            width={width}
            height={height}
            zoom={1}
            color={gridColor}
          />
        )}
        {comment ? (
          <CommentLayer frame={frame} {...comment} />
        ) : (
          <Inspector frame={frame} />
        )}
      </div>
    </div>
  );
}
