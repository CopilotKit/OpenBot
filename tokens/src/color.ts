/**
 * OKLCH to sRGB, for the apps that can't draw an `oklch()` color: React Native, and the desktop
 * app's native first paint. Björn Ottosson's OKLab matrices; a channel outside sRGB is clipped.
 */

export type Rgb = { r: number; g: number; b: number; alpha: number };

const OKLCH =
  /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/;

export function parseOklch(color: string) {
  const match = OKLCH.exec(color.trim());
  if (!match) throw new Error(`not an oklch() color: ${color}`);
  const [, l, c, h, alpha, percent] = match;
  return {
    l: Number(l),
    c: Number(c),
    h: Number(h),
    alpha: alpha === undefined ? 1 : Number(alpha) / (percent ? 100 : 1),
  };
}

/**
 * sRGB's transfer function, from a linear channel. The channel is clipped first: a color outside
 * sRGB has a channel below 0, and a negative number to a fractional power is NaN.
 */
function encode(linear: number) {
  const c = Math.min(1, Math.max(0, linear));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

export function oklchToRgb(color: string): Rgb {
  const { l, c, h, alpha } = parseOklch(color);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encode(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: encode(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: encode(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    alpha,
  };
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when the color is translucent. */
export function oklchToHex(color: string) {
  const { r, g, b, alpha } = oklchToRgb(color);
  const rgb = `#${hex(r)}${hex(g)}${hex(b)}`;
  return alpha === 1 ? rgb : `${rgb}${hex(Math.round(alpha * 255))}`;
}
