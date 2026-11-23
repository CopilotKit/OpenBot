import { useId } from "react";

export type GridOverlayProps = {
  width: number;
  height: number;
  zoom: number;
  /**
   * The color a person picked in the Window panel. Without one, the lines take the app's ring
   * token: the minor lines at 15 %, the major lines at 30 %.
   */
  color?: string;
};

/** The 4px grid with an 8px major line drawn over the window, so a person or an agent can see what is off the grid. */
export function GridOverlay({ width, height, zoom, color }: GridOverlayProps) {
  const id = useId();
  const minor = `${id}-minor`;
  const major = `${id}-major`;
  const minorSize = 4 * zoom;
  const majorSize = 8 * zoom;
  return (
    <svg
      data-workbench-grid
      aria-hidden="true"
      width={width * zoom}
      height={height * zoom}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        pointerEvents: "none",
      }}
    >
      <defs>
        <pattern
          id={minor}
          width={minorSize}
          height={minorSize}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${minorSize} 0 L 0 0 0 ${minorSize}`}
            fill="none"
            className={color ? undefined : "stroke-ring/15"}
            stroke={color}
            strokeOpacity={color ? 0.12 : undefined}
            strokeWidth={1}
          />
        </pattern>
        <pattern
          id={major}
          width={majorSize}
          height={majorSize}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${majorSize} 0 L 0 0 0 ${majorSize}`}
            fill="none"
            className={color ? undefined : "stroke-ring/30"}
            stroke={color}
            strokeOpacity={color ? 0.28 : undefined}
            strokeWidth={1}
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${minor})`} />
      <rect width="100%" height="100%" fill={`url(#${major})`} />
    </svg>
  );
}
