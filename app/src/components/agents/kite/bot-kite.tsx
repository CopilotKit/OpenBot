import { type CSSProperties, useId } from "react";
import {
  DETAIL_MIN_SIZE,
  type Expression,
  eyeCells,
  FACE_MIN_SIZE,
  facePoint,
  KITE,
  KITE_PATH,
  KITE_STATUS,
  kiteColor,
  kiteTones,
  type Point,
  patternShapes,
  pixelUnit,
  STILL_MAX_SIZE,
  sailPattern,
  seeded,
  statusPixel,
  WEAVE_MIN_SIZE,
} from "./kite";

export type KiteState = "idle" | "working" | "waiting";

/**
 * A Bot drawn as a kite in its own colours: the colour its seed picks (the same slot as its orb) and a
 * sail pattern of its own, in a lighter tone of that colour. The Kite Bot skin draws Bots this way.
 *
 * The face shows only at moments of contact. A kite drawn large enough to be what the page is about
 * (48px and up, such as the top of a conversation) is awake: its pixels gather into a pair of eyes
 * that look toward the text beside it. A smaller kite wakes on contact (`awake`): a row or tile
 * pointed at, or the Bot you are with. Its eyes stand by rather than chase the pointer, now and then
 * glancing a pixel aside and back. Every face blinks on the Bot's own schedule. A Bot waiting on the
 * person looks straight out with taller eyes and shows an amber pixel, and a working Bot's face steps
 * back while a blue pixel keeps time. Everywhere else a kite is a still, faceless shape, so twenty of
 * them in a sidebar cost nothing.
 *
 * Under 22px there is no face, and at 32px and under the body never moves (a waiting Bot over 32px
 * nudges every few seconds). Reduced motion stills everything (kite.css). The colours for both
 * themes ride on the element, and kite.css picks one.
 */
export function BotKite({
  seed,
  name,
  size = 32,
  state = "idle",
  awake = false,
  look: gaze,
}: {
  seed: string;
  name: string;
  size?: number;
  state?: KiteState;
  /**
   * Wakes an idle kite drawn under 48px, as one at the top of a conversation always is: its pixels
   * gather into eyes that stand by. A tile or a row does this while the person points at it or
   * focuses it, and a sidebar row while its Bot is the one on screen.
   */
  awake?: boolean;
  /** Where its eyes look, in whole pixels. By default a waiting Bot looks out, any other toward the text. */
  look?: Point;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const color = kiteColor(seed);
  const pattern = sailPattern(seed);
  const light = kiteTones(color, false);
  const dark = kiteTones(color, true);
  const detail = size >= DETAIL_MIN_SIZE;
  const weave = size >= WEAVE_MIN_SIZE;
  const expression: Expression | null =
    size < FACE_MIN_SIZE
      ? null
      : state === "waiting"
        ? "tall"
        : state === "idle" && (detail || awake)
          ? "open"
          : null;
  const look: Point = gaze ?? (state === "waiting" ? [0, 0] : [1, 0]);
  const gap = expression && detail ? faceWindow(size, expression, look) : null;
  const status = state === "idle" ? null : statusGeometry(size, state);
  const style = {
    "--kite-body": light.body,
    "--kite-panel": light.panel,
    "--kite-spar": light.spar,
    "--kite-edge": light.edge,
    "--kite-eye": light.eye,
    "--kite-body-dark": dark.body,
    "--kite-panel-dark": dark.panel,
    "--kite-spar-dark": dark.spar,
    "--kite-edge-dark": dark.edge,
    "--kite-eye-dark": dark.eye,
    // Every 3–7 s, on the Bot's own seed, so a team never blinks in unison.
    "--kite-blink": `${(3 + 4 * seeded(seed, "blink")).toFixed(2)}s`,
    "--kite-blink-delay": `${(-7 * seeded(seed, "phase")).toFixed(2)}s`,
    // A small face's glance: every 6–10 s, one whole pixel, to a side the seed picks.
    "--kite-glance": `${(6 + 4 * seeded(seed, "glance")).toFixed(2)}s`,
    "--kite-glance-delay": `${(-10 * seeded(seed, "glance-phase")).toFixed(2)}s`,
    // Unrounded, so the step lands on a whole screen pixel.
    "--kite-glance-by": `${(seeded(seed, "glance-side") < 0.5 ? -1 : 1) * pixelUnit(size)}px`,
    height: size,
    width: size,
  } as CSSProperties;

  return (
    <span
      role="img"
      aria-label={name}
      data-kite={state}
      data-sail={`${color.name} ${pattern}`}
      className="bot-kite inline-flex shrink-0"
      style={style}
    >
      <svg
        aria-hidden="true"
        className="block overflow-visible"
        height={size}
        // Inline, so a menu row's `[&_svg]:size-4` never squeezes a kite to an icon's size.
        style={{ height: size, width: size }}
        viewBox="-0.5 -0.5 1 1"
        width={size}
      >
        <defs>
          <clipPath id={`${id}-sail`}>
            <path d={KITE_PATH} />
          </clipPath>
          {detail ? (
            // A one-hue fall of light down the sail.
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id={`${id}-fall`}
              x1="0"
              x2="0"
              y1={KITE.nose[1]}
              y2={KITE.tail[1]}
            >
              <stop offset="0" stopColor="#fff" stopOpacity="0.08" />
              <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity="0.1" />
            </linearGradient>
          ) : null}
          {weave ? <Weave id={`${id}-weave`} size={size} /> : null}
          {gap ? (
            // While the eyes are in, the spars stop a pixel short of them.
            <mask
              height="1"
              id={`${id}-window`}
              maskUnits="userSpaceOnUse"
              width="1"
              x="-0.5"
              y="-0.5"
            >
              <rect fill="#fff" height="1" width="1" x="-0.5" y="-0.5" />
              <rect fill="#000" {...gap} />
            </mask>
          ) : null}
          {status ? (
            // The status pixel's ring is cut out of the body, so it reads on any surface.
            <mask
              height="2"
              id={`${id}-status`}
              maskUnits="userSpaceOnUse"
              width="2"
              x="-1"
              y="-1"
            >
              <rect fill="#fff" height="2" width="2" x="-1" y="-1" />
              <rect fill="#000" {...status.cut} />
            </mask>
          ) : null}
        </defs>
        <g mask={status ? `url(#${id}-status)` : undefined}>
          <g
            className={
              state === "waiting" && size > STILL_MAX_SIZE
                ? "bot-kite-nudge"
                : undefined
            }
          >
            <g clipPath={`url(#${id}-sail)`}>
              <rect
                height="1"
                style={{ fill: "var(--kb)" }}
                width="1"
                x="-0.5"
                y="-0.5"
              />
              <g style={{ fill: "var(--kp)" }}>
                {patternShapes(pattern).map((shape) =>
                  shape.kind === "polygon" ? (
                    <polygon
                      key={shape.points.join(" ")}
                      points={shape.points.map((p) => p.join(",")).join(" ")}
                    />
                  ) : (
                    <rect
                      height={shape.height}
                      key={`${shape.x},${shape.y}`}
                      width={shape.width}
                      x={shape.x}
                      y={shape.y}
                    />
                  ),
                )}
              </g>
              {detail ? (
                <rect
                  fill={`url(#${id}-fall)`}
                  height="1"
                  width="1"
                  x="-0.5"
                  y="-0.5"
                />
              ) : null}
              {weave ? (
                <rect
                  fill={`url(#${id}-weave)`}
                  height="1"
                  width="1"
                  x="-0.5"
                  y="-0.5"
                />
              ) : null}
              {detail ? (
                <g
                  fill="none"
                  mask={gap ? `url(#${id}-window)` : undefined}
                  strokeLinecap="round"
                  strokeWidth={Math.max(1 / size, 0.011)}
                  style={{ stroke: "var(--ks)" }}
                >
                  <path d={`M${KITE.nose.join(" ")}L${KITE.tail.join(" ")}`} />
                  <path
                    d={`M${KITE.left.join(" ")}Q${KITE.cross[0]} ${KITE.cross[1] + 0.03} ${KITE.right.join(" ")}`}
                  />
                </g>
              ) : null}
            </g>
            <path
              d={KITE_PATH}
              fill="none"
              strokeLinejoin="miter"
              strokeWidth={1 / size}
              style={{ stroke: "var(--ke)" }}
            />
            {expression ? (
              <PixelEyes
                expression={expression}
                look={look}
                seed={seed}
                size={size}
                standby={!detail}
              />
            ) : null}
          </g>
        </g>
        {status ? <StatusPixel {...status} /> : null}
      </svg>
    </span>
  );
}

/** The fine square weave of ripstop kite fabric. */
function Weave({ id, size }: { id: string; size: number }) {
  const step = size >= 140 ? 0.06 : 0.08;
  return (
    <pattern
      height={step}
      id={id}
      patternUnits="userSpaceOnUse"
      width={step}
      x="-0.5"
      y="-0.5"
    >
      <path
        d={`M0 0V${step}M0 0H${step}`}
        fill="none"
        stroke="#fff"
        strokeOpacity="0.075"
        strokeWidth={1 / size}
      />
    </pattern>
  );
}

/**
 * Where a face cell lands, in whole CSS pixels: the eyes are pixel art, so every edge sits on the
 * screen's grid at any size.
 */
function cellBox(size: number, column: number, row: number) {
  const pixel = Math.round(pixelUnit(size) * size);
  const [fx, fy] = facePoint(size);
  const left = Math.round((fx + 0.5) * size) + column * pixel - pixel / 2;
  const top = Math.round((fy + 0.5) * size) + row * pixel - pixel / 2;
  const snap = (v: number) => Math.round(v) / size - 0.5;
  return {
    x: snap(left),
    y: snap(top),
    width: pixel / size,
    height: pixel / size,
  };
}

/** The face's window: the eyes' bounds and a pixel and a half more on every side. */
function faceWindow(size: number, expression: Expression, look: Point) {
  const cells = eyeCells(expression, look);
  const columns = cells.map((cell) => cell.column);
  const rows = cells.map((cell) => cell.row);
  const unit = pixelUnit(size);
  const from = cellBox(size, Math.min(...columns), Math.min(...rows));
  const to = cellBox(size, Math.max(...columns), Math.max(...rows));
  return {
    x: from.x - 1.5 * unit,
    y: from.y - 1.5 * unit,
    width: to.x + to.width - from.x + 3 * unit,
    height: to.y + to.height - from.y + 3 * unit,
  };
}

/**
 * The pixel eyes. Each pixel flies in from a seeded spot within three pixels of its place, one after
 * another, so the eyes gather rather than appear. The rows above the bottom one close to blink. On
 * `standby` (a face drawn small) the pair glances a pixel aside now and then; a large face holds its
 * look, since it looks at the words beside it.
 */
function PixelEyes({
  expression,
  look,
  seed,
  size,
  standby,
}: {
  expression: Expression;
  look: Point;
  seed: string;
  size: number;
  standby: boolean;
}) {
  const unit = pixelUnit(size);
  const cells = eyeCells(expression, look);
  const eye = (cell: (typeof cells)[number], index: number) => {
    const scatter = (salt: string) =>
      ((seeded(seed, `${salt}${index}`) - 0.5) * unit * 6).toFixed(4);
    return (
      <rect
        className="bot-kite-eye"
        key={`${cell.column},${cell.row}`}
        style={
          {
            "--sx": `${scatter("x")}px`,
            "--sy": `${scatter("y")}px`,
            "--gather-delay": `${Math.round((index / cells.length) * 245)}ms`,
          } as CSSProperties
        }
        {...cellBox(size, cell.column, cell.row)}
      />
    );
  };
  const lids = cells.filter((cell) => cell.lid);
  const base = cells.filter((cell) => !cell.lid);
  return (
    <g
      className={standby ? "bot-kite-glance" : undefined}
      shapeRendering="crispEdges"
      style={{ fill: "var(--kx)" }}
    >
      <g className="bot-kite-lids">
        {lids.map((cell) => eye(cell, cells.indexOf(cell)))}
      </g>
      {base.map((cell) => eye(cell, cells.indexOf(cell)))}
    </g>
  );
}

/**
 * Status lives in a square pixel beside the body, never in it, in reserved colours. A ring around it
 * is cut out of the body (`cut`, a mask in `BotKite`), so it reads on the sidebar, a card or the page.
 */
function statusGeometry(size: number, state: Exclude<KiteState, "idle">) {
  const { half, ring } = statusPixel(size);
  const [x, y] = KITE.dot;
  return {
    state,
    size,
    pixel: { x: x - half, y: y - half, width: 2 * half, height: 2 * half },
    cut: {
      x: x - half - ring,
      y: y - half - ring,
      width: 2 * (half + ring),
      height: 2 * (half + ring),
    },
  };
}

function StatusPixel({
  state,
  size,
  pixel,
}: ReturnType<typeof statusGeometry>) {
  const color = KITE_STATUS[state];
  return (
    <g shapeRendering="crispEdges">
      {state === "working" ? (
        <rect
          className="bot-kite-pulse"
          fill="none"
          stroke={color}
          strokeWidth={Math.max(1 / size, 0.012)}
          {...pixel}
        />
      ) : null}
      <rect
        className={state === "waiting" ? "bot-kite-beat" : undefined}
        fill={color}
        {...pixel}
      />
    </g>
  );
}
