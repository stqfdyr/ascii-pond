// Small math and list helpers shared by the engine and every species.

export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const angleDiff = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};
export const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k | 0, a[1] + (b[1] - a[1]) * k | 0, a[2] + (b[2] - a[2]) * k | 0];
export const shade = (c, k) => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0, Math.min(255, c[2] * k) | 0];
export const ramp = (stops, t) => {
  const x = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
};
export const packRgb = (c) => (c[0] << 16) | (c[1] << 8) | c[2];

/** Deterministic integer hash to [0, 1): keeps texture and markings pinned to the skin. */
export function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smoothstep(0, 1, x - xi), v = smoothstep(0, 1, y - yi);
  const a = hash3(xi, yi, seed), b = hash3(xi + 1, yi, seed);
  const c = hash3(xi, yi + 1, seed), d = hash3(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** A glyph that follows a direction in screen space, for fin rays and ripple rings. */
export function lineGlyph(dx, dy) {
  const d = Math.hypot(dx, dy) || 1;
  if (Math.abs(dy) < 0.38 * d) return "-";
  if (Math.abs(dx) < 0.38 * d) return "|";
  return dx * dy > 0 ? "\\" : "/";
}

/** Sum of pushes away from every box within `margin` of (x, y), each scaled 0..1 by closeness. */
export function repel(boxes, x, y, margin, out) {
  out.x = 0;
  out.y = 0;
  for (const b of boxes) {
    let ox = x - clamp(x, b.left, b.right);
    let oy = y - clamp(y, b.top, b.bottom);
    let d = Math.hypot(ox, oy);
    if (d > margin) continue;
    if (d < 1e-3) {
      // Inside the box: head for the nearest edge.
      const edges = [b.left - x, x - b.right, b.top - y, y - b.bottom];
      const nearest = edges.indexOf(Math.max(...edges));
      ox = nearest === 0 ? -1 : nearest === 1 ? 1 : 0;
      oy = nearest === 2 ? -1 : nearest === 3 ? 1 : 0;
      d = 0;
    }
    const len = Math.hypot(ox, oy) || 1;
    out.x += (ox / len) * (1 - d / margin);
    out.y += (oy / len) * (1 - d / margin);
  }
  return out;
}


/**
 * Keep the items that pass `alive`, in order, without allocating a new array:
 * pellets and ripples are churned every step, and creatures hold references into them.
 */
export function compact(list, alive) {
  let w = 0;
  for (let i = 0; i < list.length; i++) if (alive(list[i])) list[w++] = list[i];
  list.length = w;
}
