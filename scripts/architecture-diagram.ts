/**
 * Draws the OpenBot architecture as a hand-drawn SVG, one file per colour scheme.
 *
 * rough.js is the same engine Excalidraw draws with, so the shapes get the wobble of a whiteboard
 * rather than the machine-perfect boxes of a Mermaid render. The seed is fixed, so regenerating
 * produces byte-identical output and the diagram does not churn in diffs.
 */
import { RoughGenerator } from "roughjs/bin/generator.js";

const W = 1420;
const H = 852;

type Theme = {
  name: string;
  paper: string;
  ink: string;
  muted: string;
  faint: string;
  gate: string;
  allow: string;
  refuse: string;
  bring: string;
  fillWeight: number;
};

const LIGHT: Theme = {
  name: "light",
  paper: "#fffefb",
  ink: "#1f2328",
  muted: "#5b6570",
  faint: "#aeb6bf",
  gate: "#f59e0b",
  allow: "#10b981",
  refuse: "#ef4444",
  bring: "#6366f1",
  fillWeight: 1.1,
};

const DARK: Theme = {
  name: "dark",
  paper: "#0f1216",
  ink: "#e9edf2",
  muted: "#98a3b0",
  faint: "#4a5361",
  gate: "#f0b429",
  allow: "#34d399",
  refuse: "#f87171",
  bring: "#8b8ff5",
  fillWeight: 0.9,
};

const FONT = `ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** Rough's randomness is seeded per shape, so every run draws the same wobble. */
let seed = 1;
const nextSeed = () => (seed = (seed * 1103515245 + 12345) % 2147483648);

const gen = new RoughGenerator();
const out: string[] = [];

function escapeText(body: string): string {
  return body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function draw(drawable: ReturnType<RoughGenerator["rectangle"]>): void {
  for (const path of gen.toPaths(drawable)) {
    const fill = path.fill ?? "none";
    const stroke = path.stroke ?? "none";
    out.push(
      `<path d="${path.d}" fill="${fill}" stroke="${stroke}" stroke-width="${path.strokeWidth ?? 1}" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }
}

type BoxOptions = {
  stroke: string;
  fill?: string;
  strokeWidth?: number;
  dashed?: boolean;
  roughness?: number;
};

function box(
  x: number,
  y: number,
  w: number,
  h: number,
  t: Theme,
  o: BoxOptions,
): void {
  draw(
    gen.rectangle(x, y, w, h, {
      seed: nextSeed(),
      stroke: o.stroke,
      strokeWidth: o.strokeWidth ?? 1.6,
      roughness: o.roughness ?? 1.15,
      bowing: 1.4,
      fill: o.fill,
      fillStyle: "solid",
      fillWeight: t.fillWeight,
      strokeLineDash: o.dashed ? [9, 7] : undefined,
    }),
  );
}

type TextOptions = {
  size?: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  spacing?: number;
  italic?: boolean;
};

function text(x: number, y: number, body: string, o: TextOptions = {}): void {
  out.push(
    `<text x="${x}" y="${y}" font-family='${FONT}' font-size="${o.size ?? 14}" ` +
      `font-weight="${o.weight ?? 400}" fill="${o.fill}" text-anchor="${o.anchor ?? "start"}" ` +
      `${o.spacing ? `letter-spacing="${o.spacing}" ` : ""}` +
      `${o.italic ? `font-style="italic" ` : ""}` +
      `>${escapeText(body)}</text>`,
  );
}

/** A stack of small lines inside a box, returning the y it finished on. */
function lines(
  x: number,
  y: number,
  items: string[],
  t: Theme,
  size = 13.5,
  step = 21,
): number {
  let cursor = y;
  for (const item of items) {
    text(x, cursor, item, { size, fill: t.muted });
    cursor += step;
  }
  return cursor;
}

function arrowHead(
  x: number,
  y: number,
  angle: number,
  colour: string,
  scale = 1,
): void {
  const len = 13 * scale;
  const spread = 0.42;
  const a = [
    x - len * Math.cos(angle - spread),
    y - len * Math.sin(angle - spread),
  ];
  const b = [
    x - len * Math.cos(angle + spread),
    y - len * Math.sin(angle + spread),
  ];
  draw(
    gen.polygon(
      [
        [x, y],
        [a[0] as number, a[1] as number],
        [b[0] as number, b[1] as number],
      ],
      {
        seed: nextSeed(),
        stroke: colour,
        strokeWidth: 1.3,
        roughness: 0.7,
        fill: colour,
        fillStyle: "solid",
        fillWeight: 2,
      },
    ),
  );
}

type ArrowOptions = {
  colour: string;
  width?: number;
  dashed?: boolean;
  head?: boolean;
  tailHead?: boolean;
};

function arrow(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  o: ArrowOptions,
): void {
  draw(
    gen.line(x1, y1, x2, y2, {
      seed: nextSeed(),
      stroke: o.colour,
      strokeWidth: o.width ?? 1.6,
      roughness: 0.9,
      bowing: 1.5,
      strokeLineDash: o.dashed ? [8, 6] : undefined,
    }),
  );
  const angle = Math.atan2(y2 - y1, x2 - x1);
  if (o.head !== false) arrowHead(x2, y2, angle, o.colour);
  if (o.tailHead) arrowHead(x1, y1, angle + Math.PI, o.colour);
}

function label(
  x: number,
  y: number,
  body: string,
  colour: string,
  anchor: "start" | "middle" | "end" = "middle",
): void {
  text(x, y, body, { size: 12.5, fill: colour, anchor, weight: 500 });
}

function render(t: Theme): string {
  seed = 1;
  out.length = 0;

  out.push(`<rect width="${W}" height="${H}" fill="${t.paper}"/>`);

  // ---- title -------------------------------------------------------------
  text(64, 56, "OpenBot", { size: 26, weight: 700, fill: t.ink });
  text(
    64,
    82,
    "Every action a Bot takes is decided before it happens and recorded after.",
    {
      size: 15,
      fill: t.muted,
    },
  );

  // ---- the Bots, along the top ------------------------------------------
  const botY = 126;
  const botH = 92;
  const bots: [number, number, string, string, boolean][] = [
    [372, 212, "agent-bot :4200", "proof-of-concept AG-UI Bot", false],
    [606, 212, "agent-langgraph :4201", "LangGraph AG-UI Bot", false],
    [840, 250, "your agent", "any AG-UI endpoint, any framework", true],
  ];
  text(372, botY - 14, "BOTS", {
    size: 11.5,
    weight: 700,
    fill: t.faint,
    spacing: 1.6,
  });
  for (const [x, w, name, sub, byo] of bots) {
    box(x, botY, w, botH, t, {
      stroke: byo ? t.bring : t.ink,
      dashed: byo,
      strokeWidth: byo ? 1.8 : 1.6,
    });
    text(x + 18, botY + 34, name, {
      size: 15,
      weight: 650,
      fill: byo ? t.bring : t.ink,
    });
    text(x + 18, botY + 58, sub, { size: byo ? 12.5 : 13, fill: t.muted });
    if (byo)
      text(x + 18, botY + 79, "bring your own", {
        size: 12.5,
        fill: t.bring,
        italic: true,
      });
  }

  // ---- you, on the left --------------------------------------------------
  const youX = 64;
  const youY = 296;
  const youW = 232;
  const youH = 196;
  box(youX, youY, youW, youH, t, { stroke: t.ink });
  text(youX + 18, youY + 36, "you", { size: 18, weight: 700, fill: t.ink });
  text(youX + 18, youY + 58, "app :3010", { size: 13, fill: t.muted });
  lines(
    youX + 18,
    youY + 92,
    ["channels and chat", "the Bot's live screen", "take the wheel", "/admin"],
    t,
  );

  // a Bot that reaches something it should not do alone hands the browser back to a person
  const hX = youX;
  const hY = 560;
  box(hX, hY, youW, 156, t, { stroke: t.muted, dashed: true });
  text(hX + 18, hY + 34, "when it needs you", {
    size: 15,
    weight: 650,
    fill: t.ink,
  });
  lines(
    hX + 18,
    hY + 62,
    [
      "it stops and asks,",
      "you take the wheel",
      "in its browser,",
      "and hand it back",
    ],
    t,
    13,
    22,
  );

  // ---- the server, in the middle ----------------------------------------
  const svX = 372;
  const svY = 296;
  const svW = 476;
  const svH = 304;
  box(svX, svY, svW, svH, t, { stroke: t.ink, strokeWidth: 2 });
  text(svX + 22, svY + 36, "server :3001", {
    size: 18,
    weight: 700,
    fill: t.ink,
  });
  text(svX + 22, svY + 58, "CopilotKit runtime, auth, roles, teammates", {
    size: 13,
    fill: t.muted,
  });

  // the gateway: the choke point everything passes through
  const gX = svX + 22;
  const gY = svY + 82;
  const gW = svW - 44;
  const gH = 194;
  box(gX, gY, gW, gH, t, { stroke: t.gate, strokeWidth: 2.4, roughness: 1.4 });
  text(gX + 18, gY + 32, "the gateway", {
    size: 16,
    weight: 700,
    fill: t.gate,
  });
  lines(
    gX + 18,
    gY + 62,
    [
      "1.  resolve the target",
      "2.  decide  ·  your CEL policy, deny before allow",
      "3.  record  ·  an audit row, allowed or refused",
      "4.  act, or refuse and name the rule",
    ],
    t,
    13.5,
    26,
  );
  text(gX + 18, gY + 176, "browser · files · MCP · components", {
    size: 12,
    fill: t.faint,
  });

  // ---- the computers, on the right --------------------------------------
  const cX = 1076;
  const cY = 296;
  const cW = 300;
  text(cX, cY - 14, "A COMPUTER EACH", {
    size: 11.5,
    weight: 700,
    fill: t.faint,
    spacing: 1.6,
  });
  const computers = ["risk-analyst", "knowledge", "your agent"];
  computers.forEach((name, i) => {
    const y = cY + i * 100;
    box(cX, y, cW, 84, t, { stroke: t.ink });
    text(cX + 18, y + 30, name, { size: 15, weight: 650, fill: t.ink });
    text(cX + 18, y + 52, "Chromium · its own logins", {
      size: 12.5,
      fill: t.muted,
    });
    text(cX + 18, y + 70, "/workspace · its own files", {
      size: 12.5,
      fill: t.muted,
    });
  });

  // ---- supervisor --------------------------------------------------------
  const supX = cX;
  const supY = 656;
  box(supX, supY, cW, 90, t, { stroke: t.ink, dashed: true });
  text(supX + 18, supY + 30, "supervisor :4500", {
    size: 14.5,
    weight: 650,
    fill: t.ink,
  });
  text(supX + 18, supY + 54, "the only process that", {
    size: 12.5,
    fill: t.muted,
  });
  text(supX + 18, supY + 72, "creates a computer", {
    size: 12.5,
    fill: t.muted,
  });

  text(cX, 782, "no Bot can read another's files", {
    size: 12.5,
    fill: t.muted,
    italic: true,
  });
  text(cX, 802, "or reuse another's sign-ins", {
    size: 12.5,
    fill: t.muted,
    italic: true,
  });

  // ---- stores, along the bottom -----------------------------------------
  const dbX = 372;
  const dbY = 660;
  box(dbX, dbY, 226, 118, t, { stroke: t.ink });
  text(dbX + 18, dbY + 32, "PostgreSQL :5432", {
    size: 14.5,
    weight: 650,
    fill: t.ink,
  });
  lines(
    dbX + 18,
    dbY + 58,
    ["the audit trail", "policy, grants", "credentials, encrypted"],
    t,
    12.5,
    19,
  );

  const intX = 622;
  box(intX, dbY, 226, 118, t, { stroke: t.ink });
  text(intX + 18, dbY + 32, "CopilotKit Intelligence", {
    size: 14.5,
    weight: 650,
    fill: t.ink,
  });
  lines(
    intX + 18,
    dbY + 58,
    ["durable threads", "memory", "external service"],
    t,
    12.5,
    19,
  );

  // ---- the wiring --------------------------------------------------------
  // you -> server, and the answer back
  arrow(youX + youW + 6, youY + 76, svX - 8, youY + 76, { colour: t.ink });
  label((youX + youW + svX) / 2, youY + 62, "a turn", t.muted);
  arrow(svX - 8, youY + 132, youX + youW + 6, youY + 132, {
    colour: t.ink,
    dashed: true,
  });
  label((youX + youW + svX) / 2, youY + 156, "the answer", t.muted);

  // server -> bots and back
  arrow(svX + 140, svY - 8, svX + 140, botY + botH + 8, { colour: t.ink });
  label(svX + 92, svY - 36, "AG-UI", t.muted);
  arrow(svX + 320, botY + botH + 8, svX + 320, svY - 8, {
    colour: t.ink,
    dashed: true,
  });
  label(svX + 390, svY - 36, "a tool call", t.muted);
  // the one you bring plugs in exactly the same way
  arrow(940, botY + botH + 8, svX + svW - 40, svY - 8, {
    colour: t.bring,
    dashed: true,
    width: 1.5,
  });

  // the gateway -> a computer, but only once it has decided so
  arrow(svX + svW + 8, gY + 58, cX - 10, cY + 42, {
    colour: t.allow,
    width: 2.2,
  });
  label((svX + svW + cX) / 2, gY + 26, "allowed", t.allow);

  // ...and the refusal, which never reaches the computer at all
  const ry = gY + 150;
  const rx1 = svX + svW + 8;
  const rx2 = rx1 + 116;
  arrow(rx1, ry, rx2, ry, { colour: t.refuse, head: false, width: 2.2 });
  const cross = 10;
  for (const [dx1, dy1, dx2, dy2] of [
    [-cross, -cross, cross, cross],
    [cross, -cross, -cross, cross],
  ]) {
    draw(
      gen.line(
        rx2 + 14 + (dx1 as number),
        ry + (dy1 as number),
        rx2 + 14 + (dx2 as number),
        ry + (dy2 as number),
        {
          seed: nextSeed(),
          stroke: t.refuse,
          strokeWidth: 2.6,
          roughness: 1.1,
        },
      ),
    );
  }
  label(rx2 + 14, ry + 40, "refused,", t.refuse);
  label(rx2 + 14, ry + 57, "naming the rule", t.refuse);

  // every decision lands in the trail, allowed or not
  arrow(gX + 90, svY + svH + 8, gX + 90, dbY - 8, {
    colour: t.gate,
    width: 2.2,
  });
  label(gX + 72, (svY + svH + dbY) / 2 + 4, "always", t.gate, "end");

  // threads and memory, both ways
  arrow(intX + 113, svY + svH + 8, intX + 113, dbY - 8, {
    colour: t.ink,
    dashed: true,
    tailHead: true,
  });

  // the supervisor builds each computer
  arrow(supX + 150, supY - 8, cX + 150, cY + 2 * 100 + 92, {
    colour: t.ink,
    dashed: true,
  });
  label(supX + 166, supY - 22, "creates one each", t.muted, "start");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`,
    `<title>OpenBot architecture</title>`,
    `<desc>A turn goes from the app to the server, which sends it to a Bot over AG-UI. Every tool call ` +
      `the Bot makes returns through the gateway, which resolves the target, decides it against the ` +
      `configured policy, records an audit row, and only then acts, or refuses and names the rule. ` +
      `Allowed actions reach that Bot's own computer, one container each holding its own Chromium, ` +
      `logins and workspace, created by the supervisor. Every decision lands in PostgreSQL; threads ` +
      `and memory live in CopilotKit Intelligence.</desc>`,
    ...out,
    `</svg>`,
  ].join("\n");
}

for (const theme of [LIGHT, DARK]) {
  await Bun.write(
    new URL(`../assets/architecture-${theme.name}.svg`, import.meta.url),
    render(theme),
  );
}
console.log(
  "wrote assets/architecture-light.svg and assets/architecture-dark.svg",
);
