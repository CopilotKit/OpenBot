import { useCallback, useEffect, useRef, useState } from "react";
import { CommentLayer, type CommentLayerProps } from "./CommentLayer";
import { GridOverlay } from "./GridOverlay";
import { Inspector } from "./Inspector";
import { macButtonCircles } from "./titleBar";
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
  /** The grid's color, picked in the Window panel; without one it takes the app's ring token. */
  gridColor?: string;
  /** Who hosts the page: OpenBot Desktop (default) or a browser. */
  host?: "desktop" | "browser";
  /** The path the browser bar shows, for host "browser". Default "/". */
  address?: string;
  /**
   * Whether the Windows title bar says OpenBot. Default true; false for setup, whose window has no
   * title text (`window_title_shown` in main.rs).
   */
  titled?: boolean;
  /**
   * Select mode Inspect (default): the inspector outlines the element under the pointer. False:
   * nothing is drawn over the app, and the pointer just uses it.
   */
  inspect?: boolean;
  /** Comment mode: set, the comment layer replaces the inspector. */
  comment?: Omit<CommentLayerProps, "frame"> | null;
  onFrame?(iframe: HTMLIFrameElement | null): void;
};

/*
 * macOS's own colors for the close, minimise and zoom buttons, and for all three in a window that
 * is not active. No app token means them, so they are the one color exception of the guard
 * (OS_COLORS in appUi.test.ts). The rest of the frame takes the app's neutral tokens.
 */
const LIGHTS = ["#ff5f57", "#febc2e", "#28c840"];
const INACTIVE_LIGHT = "#8e8e93";

/**
 * The Mac window's close, minimise and zoom buttons, where macOS draws them over the page
 * (titleBar.ts: `TRAFFIC_LIGHTS` in main.rs, AppKit's sizes), above the page's own content.
 */
function MacBar({ active }: { active: boolean }) {
  return (
    <div
      className="wb-window-bar wb-window-bar-mac"
      data-window-bar="mac"
      aria-hidden="true"
    >
      {macButtonCircles().map((circle, index) => (
        <span
          // The three lights never change order.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          key={index}
          className="wb-window-light ring-[0.5px] ring-foreground/20 ring-inset"
          data-window-button={["close", "minimise", "zoom"][index]}
          style={{
            left: circle.x,
            top: circle.y,
            width: circle.width,
            height: circle.height,
            background: active ? LIGHTS[index] : INACTIVE_LIGHT,
          }}
        />
      ))}
    </div>
  );
}

/** Windows' own title bar: OpenBot's title in it, except over setup (`window_title_shown`). */
function WindowsBar({ active, titled }: { active: boolean; titled: boolean }) {
  return (
    <div
      className={`wb-window-bar wb-window-bar-windows bg-muted font-sans text-xs ${active ? "text-foreground" : "text-muted-foreground"}`}
      data-window-bar="windows"
      aria-hidden="true"
    >
      <span className="wb-window-title">{titled ? "OpenBot" : ""}</span>
      <span className="wb-window-controls">
        <span className="wb-window-control text-sm">&#x2013;</span>
        <span className="wb-window-control text-sm">&#x25A1;</span>
        <span className="wb-window-control text-sm">&#x2715;</span>
      </span>
    </div>
  );
}

const BROWSER_ORIGIN = "http://localhost:3010";

function BrowserBar({ address }: { address: string }) {
  return (
    <div
      className="wb-window-bar wb-window-bar-browser border-b border-border bg-muted font-sans text-xs text-muted-foreground"
      data-window-bar="browser"
      aria-hidden="true"
    >
      <span className="wb-browser-dots">
        <span className="wb-browser-dot bg-muted-foreground/40" />
        <span className="wb-browser-dot bg-muted-foreground/40" />
        <span className="wb-browser-dot bg-muted-foreground/40" />
      </span>
      <span
        className="wb-browser-address bg-background text-foreground"
        data-browser-address
      >{`${BROWSER_ORIGIN}${address}`}</span>
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
  titled = true,
  inspect = true,
  comment,
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
      className={`wb-window wb-window-${os} bg-background shadow-2xl ring-1 ring-foreground/20`}
      style={{ zoom }}
    >
      {browser && <BrowserBar address={address ?? "/"} />}
      {!browser && os === "windows" && (
        <WindowsBar active={active} titled={titled} />
      )}
      <div
        className="wb-window-content"
        data-window-content
        style={{ width, height }}
      >
        <iframe
          data-workbench-frame
          key={frameKey}
          ref={setRef}
          src={src}
          title="OpenBot window"
          onLoad={() => onFrameRef.current?.(ref.current)}
          style={{ width, height, border: 0, colorScheme: theme }}
        />
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
          inspect && <Inspector frame={frame} />
        )}
      </div>
    </div>
  );
}
