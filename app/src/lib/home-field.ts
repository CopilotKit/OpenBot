import { ORB_PALETTES } from "./orb-palette";

/*
 * The orb's field behind Home's message box: a pale gradient in the orb's colours, centred on the
 * box and drifting slowly, with three rings of soft dots turning round its rim. Typing lights it.
 * Drawn by `components/home/home-field.tsx`; this file holds what it is drawn from.
 */

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(
    (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
  ) as [number, number, number];
}

const PERIWINKLE = ORB_PALETTES[2];
const MINT = ORB_PALETTES[0];

/**
 * The field's five colours, as 0–1 RGB for the shader: the periwinkle orb's periwinkle, sky and
 * violet, AgentOrb's pink (`oklch(68% 0.21 350)`, which no Bot palette has) and the Bot green.
 */
export const HOME_FIELD_COLORS: readonly [number, number, number][] = [
  rgb(PERIWINKLE.c2),
  rgb(PERIWINKLE.c1),
  rgb(PERIWINKLE.c3),
  rgb("#f153aa"),
  rgb(MINT.c1),
];

/**
 * How strongly the field is lit, 0–1: fully while the person writes in the box, a little while it
 * is focused and empty, not at all otherwise.
 */
export function fieldEnergy({
  focused,
  hasText,
}: {
  focused: boolean;
  hasText: boolean;
}): number {
  if (!focused) return 0;
  return hasText ? 1 : 0.3;
}

const INTRO_KEY = "openbot.home-intro-played";

type SessionStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * Whether Home's intro plays: on the first Home of a visit only. Coming back to Home, or reloading
 * the tab, shows the page in place. Kept in the session's storage, and in memory too, for a
 * privacy mode that refuses storage. `plays` only reads, so asking twice in one render gives the
 * same answer; `played` is said once the intro has started.
 */
export function createHomeIntro(storage: SessionStore | null) {
  let done = false;
  return {
    plays() {
      if (done) return false;
      try {
        return storage?.getItem(INTRO_KEY) !== "1";
      } catch {
        return true;
      }
    },
    played() {
      done = true;
      try {
        storage?.setItem(INTRO_KEY, "1");
      } catch {}
    },
  };
}

/** The app's own: one per load of the app, on the tab's session storage. */
export const homeIntro = createHomeIntro(
  typeof window === "undefined"
    ? null
    : {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
);

export const HOME_FIELD_VERTEX =
  "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";

/*
 * Positions are in device pixels, from the bottom left, as WebGL counts them. `uBox` is the message
 * box (x, y, width, height). `uIntro` runs 0 to 1 over the first view: the orb fades and grows in,
 * then each ring draws itself from the top round both sides, the inner ring first. `uEnergy` is
 * `fieldEnergy`, eased. The output is premultiplied, under a fine grain so the long fade shows no
 * bands.
 */
export const HOME_FIELD_FRAGMENT = `
precision highp float;
uniform vec4 uBox;
uniform float uTime, uEnergy, uDark, uDpr, uIntro;
uniform vec3 uC0, uC1, uC2, uC3, uC4;
float hash(float n){ return fract(sin(n * 12.9898) * 43758.5453); }
float blob(vec2 q, vec2 at, float r){ vec2 d = q - at; return exp(-dot(d, d) / (r * r)); }
void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 c = vec2(uBox.x + 0.5 * uBox.z, uBox.y + 0.5 * uBox.w);
  float R = 0.3 * uBox.z * (1.0 + 0.03 * uEnergy) * (0.86 + 0.14 * smoothstep(0.0, 0.8, uIntro));
  vec2 d = px - c;
  float rn = length(d) / R;
  vec2 q = d / R;
  float t = uTime;

  vec2 qs = q * 0.7;
  vec2 a0 = vec2(-0.35 + 0.15 * sin(t * 0.30), 0.25 + 0.12 * cos(t * 0.25));
  vec2 a1 = vec2(0.35 + 0.12 * cos(t * 0.22), 0.05 + 0.15 * sin(t * 0.33));
  vec2 a2 = vec2(0.06 * sin(t * 0.20), -0.25 + 0.12 * cos(t * 0.27));
  vec2 a3 = vec2(-0.10 + 0.20 * cos(t * 0.18 + 2.0), 0.50 + 0.10 * sin(t * 0.31));
  float w0 = blob(qs, a0, 0.75), w1 = blob(qs, a1, 0.75), w2 = blob(qs, a2, 0.68), w3 = blob(qs, a3, 0.5);
  float s = w0 + w1 + w2 + w3 * 0.5 + 1e-4;
  vec3 col = (uC0 * w0 + uC1 * w1 + uC3 * w2 + uC4 * w3 * 0.5) / s;
  col = mix(col, vec3(1.0), mix(0.30, 0.10, uDark));
  float fall = exp(-rn * rn);
  float a = fall * mix(0.5, 0.18, uDark) * (1.0 + 0.35 * uEnergy) * smoothstep(0.0, 0.7, uIntro);
  vec3 oc = col * a;
  float oa = a;

  float ang = atan(d.y, d.x);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float n = 84.0 - 10.0 * fk;
    float rk = R * (1.08 + 0.085 * fk) * (1.0 - 0.04 * uEnergy);
    float dir = k == 1 ? -1.0 : 1.0;
    float rot = dir * t * (0.045 + 0.015 * fk) * (1.0 + 1.2 * uEnergy);
    float cell = 6.2831853 / n;
    float idx = floor((ang - rot) / cell + 0.5);
    float ca = idx * cell + rot;
    float h1 = hash(idx + fk * 97.0), h2 = hash(idx * 1.7 + fk * 13.0), h3 = hash(idx * 3.3 + fk * 5.0);
    vec2 dc = c + vec2(cos(ca), sin(ca)) * (rk + (h1 - 0.5) * R * 0.012);
    float size = (1.1 + 1.3 * h2 * (1.0 - 0.3 * fk)) * uDpr;
    float dotv = 1.0 - smoothstep(size - 1.0 * uDpr, size + 1.1 * uDpr, length(px - dc));
    float tw = 0.6 + 0.4 * sin(t * 0.9 + h3 * 6.2831);
    float op = (0.55 + 0.45 * h3) * tw * (1.0 - 0.3 * fk);
    vec3 dcol = mix(uC3, uC0, 0.5 + 0.5 * sin(ca));
    dcol = mix(dcol, vec3(1.0), 0.3 * uDark);
    float pk = clamp((uIntro - 0.15 - 0.12 * fk) / 0.6, 0.0, 1.0);
    float fromTop = abs(mod(ca - 1.5708 + 3.14159, 6.28318) - 3.14159);
    float shown = 1.0 - smoothstep(pk * 3.4 - 0.35, pk * 3.4, fromTop);
    float da = dotv * op * mix(0.55, 0.28, uDark) * (1.0 + 0.4 * uEnergy) * shown;
    oc = dcol * da + oc * (1.0 - da);
    oa = da + oa * (1.0 - da);
  }

  float grain = (fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(max(oc + grain, 0.0), clamp(oa + grain, 0.0, 1.0));
}`;
