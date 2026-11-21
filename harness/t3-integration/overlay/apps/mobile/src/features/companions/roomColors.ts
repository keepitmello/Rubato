// The room's bubble colors, the way Messages places them (user a9b0890f, mockup B): the person's
// bubble is the theme's accent made deep enough for white words, so both sides read in white on a
// dark theme; the companion's stays the theme's grey card. Worked out from the theme's own colors,
// so every theme, light or dark, gets its own.

/** A theme color (#rgb, #rrggbb, #rrggbbaa, rgb(…) or rgba(…)) as 0…1 sRGB channels, or null. */
export function parseColor(color: string): readonly [number, number, number] | null {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const full = hex.length === 3 ? hex.split("").map((digit) => digit + digit).join("") : hex;
    const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
    return [channel(0), channel(1), channel(2)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1]?.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (rgb && rgb.length >= 3 && rgb.slice(0, 3).every(Number.isFinite)) return [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255];
  return null;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB to OKLCH (Björn Ottosson's OKLab): lightness, chroma, hue in degrees. */
export function toOklch([r, g, b]: readonly [number, number, number]): readonly [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

/** OKLCH to linear sRGB, unclamped (a channel outside 0…1 is out of gamut). */
function oklchToLinear(L: number, C: number, H: number): readonly [number, number, number] {
  const A = C * Math.cos((H * Math.PI) / 180);
  const B = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (linear: readonly number[]) => linear.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
const luminance = (linear: readonly number[]) => 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
/** WCAG contrast of white words on a color given in linear sRGB. */
export const whiteContrast = (linear: readonly number[]) => 1.05 / (luminance(linear) + 0.05);

const toHex = (linear: readonly number[]) =>
  `#${linear.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255).toString(16).padStart(2, "0")).join("")}`;

/** White words on the person's bubble read at least this well (WCAG AA for body text). */
export const SENT_CONTRAST = 4.5;

/**
 * The person's bubble: the accent's hue and chroma at the lightest lightness where white words
 * still read at SENT_CONTRAST, the chroma eased down only where the deep color would leave the
 * screen's gamut. An accent already deep enough stays as it is.
 */
export function sentBubbleColor(accent: string): string {
  const rgb = parseColor(accent) ?? ([10 / 255, 132 / 255, 1] as const);
  const linear = rgb.map(toLinear);
  if (whiteContrast(linear) >= SENT_CONTRAST) return toHex(linear);
  const [start, C, H] = toOklch(rgb);
  for (let L = start; L > 0.2; L -= 0.005) {
    let chroma = C;
    let candidate = oklchToLinear(L, chroma, H);
    while (!inGamut(candidate) && chroma > 0) {
      chroma = Math.max(0, chroma - 0.005);
      candidate = oklchToLinear(L, chroma, H);
    }
    // Judged as the screen will show it, after rounding to 8-bit channels.
    const shown = toHex(candidate);
    if (whiteContrast(parseColor(shown)!.map(toLinear)) >= SENT_CONTRAST) return shown;
  }
  return toHex(oklchToLinear(0.45, Math.min(C, 0.08), H));
}

/** The words on the person's bubble. */
export const SENT_FOREGROUND = "#ffffff";
