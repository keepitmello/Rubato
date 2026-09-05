// The approved Resonance preview, rasterized into terminal braille cells.
// No TUI dependencies: this module is in the launcher's first import graph.
export const INTRO_MS = 4100;
export const RELEASE_MS = 2400;
export const CLEAR_MS = 400;
export const WORDMARK = "𝒓𝒖𝒃𝒂𝒕𝒐";
const W = 160, H = 112;
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const palette = [
  [54, 49, 63], [85, 73, 95], [118, 97, 130], [156, 123, 161],
  [188, 152, 184], [212, 173, 188], [230, 189, 169], [243, 212, 181], [255, 240, 213],
];
let seed = 1927;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const curves = [
  [[53, 91], [65, 93], [65, 73], [69, 42]],
  [[69, 42], [68, 48], [67, 54], [67, 62]],
  [[67, 62], [73, 36], [88, 27], [99, 35]],
  [[99, 35], [111, 45], [99, 59], [90, 51]],
];
function bezier(p, t) {
  const a = 1 - t;
  return [0, 1].map((i) =>
    a ** 3 * p[0][i] + 3 * a * a * t * p[1][i] + 3 * a * t * t * p[2][i] + t ** 3 * p[3][i]);
}
const points = [];
curves.forEach((curve, ci) => {
  for (let i = 0; i < 150; i++) {
    const t = i / 149, p = bezier(curve, t), q = bezier(curve, Math.min(1, t + .005));
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    for (let strand = -2; strand <= 2; strand++) {
      points.push({
        x: p[0] - dy / len * strand * 1.25, y: p[1] + dx / len * strand * 1.25,
        sx: 8 + random() * 144, sy: 12 + random() * 88,
        phase: random() * Math.PI * 2, speed: .6 + random(),
        order: (ci + t) / curves.length, strand,
      });
    }
  }
});
const dust = Array.from({ length: 75 }, () => ({ x: random() * W, y: random() * H, p: random() * 6.28 }));

export function resonanceColor(index, env = process.env) {
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return "";
  const rgb = palette[Math.max(0, Math.min(8, index))];
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return `\x1b[38;2;${rgb.join(";")}m`;
  }
  return `\x1b[38;5;${16 + 36 * Math.round(rgb[0] / 51) + 6 * Math.round(rgb[1] / 51) + Math.round(rgb[2] / 51)}m`;
}

/** time never loops; only the middle breathes until the owner supplies release. */
export function renderResonance({
  time = 0, release = null, columns = 80, rows = 28, env = process.env,
  artColumns = columns, artRows = rows, offsetColumns = 0, offsetRows = 0, releaseRadius = 90,
} = {}) {
  const width = columns * 2, height = rows * 4;
  const ink = new Float32Array(width * height), tint = new Float32Array(width * height);
  const burst = release === null ? 0 : clamp(release / RELEASE_MS);
  const spread = 1 - (1 - burst) ** 2;
  const fade = release === null ? 0 : ease((release - (RELEASE_MS - 750)) / 750);
  const reveal = ease(time / 700), gather = ease((time - 900) / 3200);
  function dot(x, y, value, color) {
    x = Math.round(x / W * artColumns * 2 + offsetColumns * 2);
    y = Math.round(y / H * artRows * 4 + offsetRows * 4);
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = y * width + x;
    if (value > ink[i]) { ink[i] = value; tint[i] = color; }
  }
  for (const p of points) {
    const g = ease((time - 900 - p.order * 360) / 2850);
    if (p.speed > .6 + .09 + .91 * g && g < .96) continue;
    const waveY = 56 + Math.sin(p.sx * .065 - time * .0012) * 8 + Math.sin(p.phase + time * .0007) * 2;
    const wave = ease((time - 300) / 1300);
    const fromY = p.sy * (1 - wave) + waveY * wave;
    const direction = Math.atan2(p.y - 60, (p.x - 80) * .85) + Math.sin(p.phase) * .35;
    const away = spread * (55 + p.speed * 24) * releaseRadius / 90;
    const shimmer = Math.max(0, Math.cos(p.order * 5 - time * .0014)) ** 12;
    dot(
      p.sx * (1 - g) + p.x * g + Math.cos(direction) * away,
      fromY * (1 - g) + p.y * g + Math.sin(direction) * away * .7,
      (.24 + .62 * g + shimmer * .14) * reveal * (1 - fade),
      clamp(.30 + p.order * .42 + shimmer * .32 + p.strand * .018),
    );
  }
  for (let ring = 0; ring < 2; ring++) {
    const phase = (time * .00018 + ring * .5) % 1;
    const radius = 21 + phase * 46, alpha = (1 - phase) * .25 * gather * (1 - spread);
    for (let i = 0; i < 100; i++) {
      const a = i / 100 * Math.PI * 2;
      if (Math.sin(a * 7 + ring * 2) < .2) continue;
      dot(80 + Math.cos(a) * radius, 59 + Math.sin(a) * radius * .48, alpha, .18 + phase * .25);
    }
  }
  for (const d of dust) {
    dot(d.x + Math.sin(time * .0002 + d.p) * 2, d.y,
      .12 * (.5 + .5 * Math.sin(time * .00065 + d.p)) * reveal * (1 - spread), .12);
  }
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
  const lines = [];
  for (let cy = 0; cy < rows; cy++) {
    let line = "", previous = -1;
    for (let cx = 0; cx < columns; cx++) {
      let mask = 0, bright = 0, color = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
        const i = (cy * 4 + y) * width + cx * 2 + x, v = ink[i];
        if (v > .055) { mask |= bits[y][x]; bright = Math.max(bright, v); color = Math.max(color, tint[i]); }
      }
      const bucket = mask ? Math.min(8, Math.floor((color * .72 + bright * .28) * 9)) : 0;
      if (mask && bucket !== previous) { line += resonanceColor(bucket, env); previous = bucket; }
      line += mask ? String.fromCharCode(0x2800 + mask) : " ";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}
