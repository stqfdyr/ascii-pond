// ascii-pond: creatures drawn as glyph tiles, swimming behind a page.
//
//   <ascii-pond fixed></ascii-pond>                       markup, with attributes as options
//   mount(element | canvas, { species, theme, ... })     or from script; see README "Options"
//
// The engine owns the water (ripples, wake, food), drawing, themes and input. Everything about a
// kind of creature lives in its species module (koi.js is one): see `species` below.
import { TAU, clamp, rand, smoothstep, mix, packRgb, lineGlyph, compact } from "./util.js";
import { koi } from "./koi.js";

/**
 * Species available by name. A species is an object with:
 *   name, colors: { dark, light }                     extra palette keys it draws with
 *   seed(pond)  grow?(pond)                           add creatures to pond.creatures; grow runs once
 *                                                     a resize has settled, to suit the new size
 *   step(pond, creature, dt)                          move one creature one sim step
 *   draw(renderer, creature, time)                    write its cells into renderer.grid
 *   wake?(renderer, creature)  splash?(pond, pellet)  floating?(pond, pellet)
 * Each creature needs `species` and a `depth` (0 deep … 1 surface; draw order); setting `gone`
 * on one removes it after the step.
 */
export const SPECIES = { koi };

// ─── palette ────────────────────────────────────────────────────────────────
// The page background and the tile background (bg) differ on purpose: tiles are
// mixed toward a slightly different black/white, so a creature reads as a wash laid on
// the page rather than a hole punched in it.
export const DARK = {
  /** The page itself (match the host page's background); tiles are mixed toward `bg`, not this. */
  page: [26, 25, 23],
  /** Page text colour, for hosts that recolour their copy during the theme wipe. */
  fg: [255, 247, 240],
  bg: [26, 25, 33],
  water: [255, 247, 240],
  shadow: [0, 0, 0],
  shadowAlpha: 0.55,
  pellet: [236, 170, 92],
  alpha: 0.8,
  depthFloor: 0.4,
  /** Skin colour carried by a tile, from shadow (0) to lit (1); the rest is page background. */
  tile: [0.68, 0.98],
  /** Glyph brightness relative to the tile under it. */
  ink: 0.42,
};

// Paper page: tiles are pale washes of the skin colour with dark glyphs etched on top.
export const LIGHT = {
  page: [245, 244, 241],
  fg: [38, 37, 35],
  bg: [245, 244, 241],
  water: [38, 37, 35],
  shadow: [60, 58, 56],
  shadowAlpha: 0.2,
  pellet: [176, 108, 40],
  alpha: 0.9,
  depthFloor: 0.55,
  tile: [0.78, 0.55],
  ink: 0.45,
};

// ─── constants ──────────────────────────────────────────────────────────────
// The sim runs at 120 Hz: a 60 Hz display takes two steps a frame and a 120 Hz one takes a
// single step, so creatures move every frame instead of snapping every other one.
const STEP = 1 / 120, MAX_STEPS = 8;
/** The wake was tuned as one deposit + blur per 60 Hz frame; it runs on sim time so refresh rate doesn't change it. */
const WAKE_STEP = 1 / 60;
const RIPPLE_SPEED = 52;
/** Seconds the window must hold still before creatures are counted again: a drag may yet reverse. */
const RESIZE_SETTLE = 1.5;
const PELLET_LIFE = 14, PELLET_SINK = 9, PELLET_MAX = 24;
const BITE_LIFE = 0.45;
const THROW_RADIUS = 34;
/** How visible a creature stays while it swims under page content. */
const DIM_UNDER_CONTENT = 0.15;
/** Content boxes closer than this merge, so creatures aren't squeezed into the slot between them. */
const MERGE_GAP_PX = 160;
/** Re-measure the content boxes this often, in frames, to follow layout shifts. */
const MEASURE_EVERY_FRAMES = 30;
/** A merge may not grow the block far beyond its parts — see the guard in mergeNearby. */
const MAX_MERGE_GROWTH = 1.6;

const rippleLife = (r) => 2.2 + r.strength * 1.6;

// ─── pond: the simulation ───────────────────────────────────────────────────
export class Pond {
  constructor(species) {
    this.species = species;
    this.creatures = [];
    this.pellets = [];
    this.ripples = [];
    this.bites = [];
    this.width = 0;
    this.height = 0;
    this.time = 0;
    this.pointer = { x: 0, y: 0, active: false };
    /** Page content creatures steer around, in canvas space. */
    this.avoid = [];
    this.nextId = 1;
    this.settleAt = 0;
  }

  resize(width, height) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    if (first) for (const s of this.species) s.seed(this);
    else this.settleAt = this.time + RESIZE_SETTLE;
  }

  /** A loose handful thrown at (x, y): each pellet lands a beat apart, then drifts and sinks. */
  feed(x, y) {
    this.ripples.push({ x, y, born: this.time, strength: 0.35 });
    const count = Math.min(5 + Math.floor(Math.random() * 3), PELLET_MAX - this.pellets.length);
    for (let k = 0; k < count; k++) {
      const a = rand(0, TAU), r = Math.sqrt(Math.random()) * THROW_RADIUS;
      const drift = rand(2, 6);
      this.pellets.push({
        x: x + Math.cos(a) * r * 1.3, y: y + Math.sin(a) * r,
        born: this.time, landAt: rand(0.15, 0.45), landed: false,
        vx: Math.cos(a) * drift, vy: Math.sin(a) * drift,
      });
    }
  }

  step(dt) {
    this.time += dt;
    if (this.settleAt && this.time >= this.settleAt) {
      this.settleAt = 0;
      for (const s of this.species) s.grow?.(this);
    }
    for (const c of this.creatures) c.species.step(this, c, dt);
    compact(this.creatures, (c) => !c.gone);

    const t = this.time;
    compact(this.pellets, (p) => t - p.born < PELLET_LIFE);
    for (const p of this.pellets) {
      if (!p.landed) {
        if (t - p.born < p.landAt) continue;
        p.landed = true;
        this.ripples.push({ x: p.x, y: p.y, born: t, strength: 0.1 });
        for (const s of this.species) s.splash?.(this, p);
        continue;
      }
      for (const s of this.species) s.floating?.(this, p);
      const damp = Math.exp(-dt * 0.2);
      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    compact(this.ripples, (r) => t - r.born < rippleLife(r));
    compact(this.bites, (b) => t - b.born < BITE_LIFE);
  }
}

// ─── renderer: the pond as a grid of glyph tiles ────────────────────────────
export class PondRenderer {
  /** `themes`: { dark, light } palettes, each already merged with every species' colours. */
  constructor(canvas, themes) {
    this.canvas = canvas;
    this.visibleCtx = canvas.getContext("2d");
    this.ctx = this.visibleCtx;
    // Two offscreen layers for the theme reveal (old palette, new palette).
    this.layerA = document.createElement("canvas");
    this.layerB = document.createElement("canvas");
    this.reveal = null;
    this.dpr = 1;
    this.cellW = 8;
    this.cellH = 12;
    this.cols = 0;
    this.rows = 0;
    this.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
    this.styles = new Map();
    this.order = [];
    this.cellDim = null;
    this.grid = null;
    this.energy = null;
    this.energyTmp = null;
    this.themes = themes;
    /** The palette being drawn with; swapped by setTheme, and per layer during a reveal. */
    this.palette = themes.dark;
  }

  resize(width, height, dpr) {
    this.dpr = dpr;
    // Near-square tiles, large enough to read each etched glyph.
    this.cellW = clamp(Math.round(width / 125), 8, 12);
    this.cellH = this.cellW + 2;
    this.cols = Math.ceil(width / this.cellW);
    this.rows = Math.ceil(height / this.cellH);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.revealWidth = width;
    this.revealHeight = height;
    this.allocLayers(dpr);

    const n = this.cols * this.rows;
    this.grid = {
      glyph: new Uint16Array(n),
      color: new Uint32Array(n),
      alpha: new Float32Array(n),
      tile: new Uint32Array(n),
      tileAlpha: new Float32Array(n),
      shadow: new Uint8Array(n),
    };
    this.energy = new Float32Array(n);
    this.energyTmp = new Float32Array(n);
    this.rippleAlpha = new Float32Array(n);
    this.rippleGlyph = new Uint8Array(n);
    this.cellDim = new Float32Array(n).fill(1);
  }

  setTheme(isLight) {
    const next = isLight ? this.themes.light : this.themes.dark;
    if (this.reveal) this.reveal.to = next;
    else this.palette = next;
  }

  render(pond) {
    if (!this.grid || this.cols === 0) return;
    if (!this.reveal) {
      this.paint(pond, this.visibleCtx, this.palette, null, this.dpr);
      return;
    }
    this.paintReveal(pond);
  }

  /** One frame drawn with one palette. `page` fills the page colour first (theme reveal only). */
  paint(pond, ctx, palette, page, scale) {
    this.palette = palette;
    this.ctx = ctx;
    const { grid } = this;
    const w = ctx.canvas.width, h = ctx.canvas.height;

    grid.glyph.fill(0);
    grid.tileAlpha.fill(0);
    grid.shadow.fill(0);
    grid.alpha.fill(0);
    grid.color.fill(0);

    // Deeper creatures first, so the ones near the surface glide over them.
    const order = this.order;
    order.length = 0;
    for (const c of pond.creatures) order.push(c);
    order.sort((a, b) => a.depth - b.depth);
    for (const c of order) c.species.draw(this, c, pond.time);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (page) {
      ctx.fillStyle = this.style(packRgb(page));
      ctx.fillRect(0, 0, w, h);
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.font = `600 ${Math.round(this.cellH * 0.72)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    this.drawShadows();
    this.drawWake();
    this.drawRipples(pond);
    this.drawPellets(pond);
    this.drawCells();
    this.drawBites(pond);
    ctx.globalAlpha = 1;
  }

  /**
   * The theme switch: draw the frame twice, once per palette, and wipe from the old one to
   * the new one with a soft-edged circle. Both layers are live, so everything keeps swimming —
   * a view transition would freeze them, because it animates a static snapshot of the page.
   */
  paintReveal(pond) {
    const rv = this.reveal;
    const began = performance.now();
    const t = clamp((began - rv.start) / rv.duration, 0, 1);
    const radius = smoothstep(0, 1, t) * (rv.maxRadius + rv.feather);
    rv.radius = radius;

    // Both palettes are painted into offscreen layers, composited there, then blitted once.
    const ls = this.layerScale;
    this.paint(pond, rv.oldCtx, rv.from, rv.from.page, ls);
    this.paint(pond, rv.newCtx, rv.to, rv.to.page, ls);

    const view = this.visibleCtx, nctx = rv.newCtx;
    const w = this.canvas.width, h = this.canvas.height;
    const lw = rv.oldCanvas.width, lh = rv.oldCanvas.height;
    // Nothing outside the circle can change, so only its box is masked and blitted.
    const pad = rv.feather;
    const x0 = clamp(Math.floor((rv.x - radius - pad) * ls), 0, lw);
    const y0 = clamp(Math.floor((rv.y - radius - pad) * ls), 0, lh);
    const x1 = clamp(Math.ceil((rv.x + radius + pad) * ls), 0, lw);
    const y1 = clamp(Math.ceil((rv.y + radius + pad) * ls), 0, lh);
    const bw = x1 - x0, bh = y1 - y0;
    if (bw > 0 && bh > 0) {
      const inner = Math.max(0, radius - rv.feather);
      nctx.setTransform(1, 0, 0, 1, 0, 0);
      nctx.globalCompositeOperation = "destination-in";
      const grad = nctx.createRadialGradient(rv.x * ls, rv.y * ls, inner * ls,
        rv.x * ls, rv.y * ls, Math.max(radius, inner + 0.01) * ls);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      nctx.fillStyle = grad;
      nctx.fillRect(x0, y0, bw, bh);
      nctx.globalCompositeOperation = "source-over";

      // Composite at layer resolution, then one upscale for the whole frame.
      const octx = rv.oldCtx;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.globalCompositeOperation = "source-over";
      octx.drawImage(rv.newCanvas, x0, y0, bw, bh, x0, y0, bw, bh);
    }

    view.setTransform(1, 0, 0, 1, 0, 0);
    view.globalCompositeOperation = "source-over";
    view.clearRect(0, 0, w, h);
    view.drawImage(rv.oldCanvas, 0, 0, lw, lh, 0, 0, w, h);
    if (t >= 1) this.endReveal();
  }

  /** Start a circular theme wipe at (x, y) in CSS pixels, ending on `to`. */
  startReveal(x, y, to) {
    if (!this.layerA) { this.palette = to; return; }
    const farthest = Math.hypot(Math.max(x, this.revealWidth - x), Math.max(y, this.revealHeight - y));
    this.reveal = {
      x, y, to, from: this.palette,
      oldCanvas: this.layerA, newCanvas: this.layerB,
      oldCtx: this.layerA.getContext("2d"), newCtx: this.layerB.getContext("2d"),
      start: performance.now(), duration: 800, feather: 64, maxRadius: farthest, radius: 0,
    };
  }

  endReveal() {
    this.palette = this.reveal.to;
    this.reveal = null;
  }

  /** Size the two reveal layers; `scale` is device pixels per CSS pixel. */
  allocLayers(scale) {
    this.layerScale = scale;
    for (const layer of [this.layerA, this.layerB]) {
      if (!layer) continue;
      layer.width = Math.round(this.revealWidth * scale);
      layer.height = Math.round(this.revealHeight * scale);
    }
  }

  /** Fade creatures under these canvas-space boxes, easing back in over a few cells around them. */
  setDimBoxes(boxes) {
    const { cols, rows, cellW: cw, cellH: ch, cellDim } = this;
    cellDim.fill(1);
    const pad = cw * 4;
    for (const b of boxes) {
      const c0 = Math.max(0, Math.floor((b.left - pad) / cw));
      const c1 = Math.min(cols - 1, Math.floor((b.right + pad) / cw));
      const r0 = Math.max(0, Math.floor((b.top - pad) / ch));
      const r1 = Math.min(rows - 1, Math.floor((b.bottom + pad) / ch));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw + cw / 2, y = r * ch + ch / 2;
          const d = Math.hypot(Math.max(b.left - x, 0, x - b.right), Math.max(b.top - y, 0, y - b.bottom));
          const i = r * cols + c;
          cellDim[i] = Math.min(cellDim[i], DIM_UNDER_CONTENT + (1 - DIM_UNDER_CONTENT) * smoothstep(0, pad, d));
        }
      }
    }
  }

  // ── water ─────────────────────────────────────────────────────────────────
  cellIndex(x, y) {
    const c = Math.floor(x / this.cellW), r = Math.floor(y / this.cellH);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  /** Leave `amount` of energy in the water at (x, y); it spreads and fades (see diffuse). */
  stir(x, y, amount) {
    const i = this.cellIndex(x, y);
    if (i >= 0) this.energy[i] = Math.min(1.5, this.energy[i] + amount);
  }

  /** Whatever swims, and the cursor, stirs the water. */
  depositWake(pond) {
    for (const c of pond.creatures) c.species.wake?.(this, c);
    if (pond.pointer.active) this.stir(pond.pointer.x, pond.pointer.y, 0.12);
  }

  /** Blur and decay, so wakes spread like ripples and fade. */
  diffuse(dt) {
    const { cols, rows, energy, energyTmp: tmp } = this;
    const decay = Math.exp(-dt * 1.1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? energy[i - 1] : energy[i];
        const rt = c < cols - 1 ? energy[i + 1] : energy[i];
        const u = r > 0 ? energy[i - cols] : energy[i];
        const d = r < rows - 1 ? energy[i + cols] : energy[i];
        tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    this.energy = tmp;
    this.energyTmp = energy;
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  style(rgb) {
    let s = this.styles.get(rgb);
    if (!s) {
      s = `rgb(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255})`;
      this.styles.set(rgb, s);
    }
    return s;
  }

  glyphAt(i, glyph, rgb, alpha) {
    const { ctx, cellW: cw, cellH: ch, cols } = this;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.style(packRgb(rgb));
    ctx.fillText(glyph, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2);
  }

  drawShadows() {
    const { grid } = this;
    for (let i = 0; i < grid.shadow.length; i++) {
      if (!grid.shadow[i] || grid.glyph[i]) continue;
      this.glyphAt(i, ":", this.palette.shadow, this.palette.shadowAlpha * this.cellDim[i]);
    }
  }

  drawWake() {
    const { energy, grid } = this;
    for (let i = 0; i < energy.length; i++) {
      const e = energy[i];
      if (e < 0.22 || grid.glyph[i] || grid.shadow[i]) continue;
      this.glyphAt(i, e > 0.5 ? "-" : ".", this.palette.water,
        Math.min(1, (e - 0.22) * 1.4) * 0.35 * this.cellDim[i]);
    }
  }

  /**
   * Expanding rings drawn as ASCII circles: each glyph follows the ring's tangent. Rings are
   * collected per cell first, so where two cross the stronger one wins instead of both glyphs
   * stacking into an X or a +.
   */
  drawRipples(pond) {
    const { cellW: cw, cellH: ch, cols, rows, grid, rippleAlpha, rippleGlyph } = this;
    rippleAlpha.fill(0);
    for (const rp of pond.ripples) {
      const age = pond.time - rp.born;
      const fade = Math.pow(1 - age / rippleLife(rp), 1.5) * rp.strength;
      for (let ring = 0; ring < 2; ring++) {
        const radius = Math.max(0, age - ring * 0.45) * RIPPLE_SPEED * (0.7 + 0.5 * rp.strength);
        if (radius < 2) continue;
        const band = cw * 0.9;
        const c0 = Math.max(0, Math.floor((rp.x - radius - cw) / cw));
        const c1 = Math.min(cols - 1, Math.floor((rp.x + radius + cw) / cw));
        const r0 = Math.max(0, Math.floor((rp.y - radius - ch) / ch));
        const r1 = Math.min(rows - 1, Math.floor((rp.y + radius + ch) / ch));
        const alpha = fade * (ring === 0 ? 0.55 : 0.3);
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const i = r * cols + c;
            if (grid.glyph[i]) continue;
            const dx = c * cw + cw / 2 - rp.x, dy = r * ch + ch / 2 - rp.y;
            const off = Math.abs(Math.hypot(dx, dy) - radius);
            if (off > band) continue;
            // Soft across the band, so the ring glides from cell to cell instead of popping.
            const a = alpha * (1 - off / band);
            if (a <= rippleAlpha[i]) continue;
            rippleAlpha[i] = a;
            rippleGlyph[i] = (ring === 1 ? "." : lineGlyph(-dy, dx)).charCodeAt(0);
          }
        }
      }
    }
    for (let i = 0; i < rippleAlpha.length; i++) {
      if (rippleAlpha[i] > 0.004) this.glyphAt(i, String.fromCharCode(rippleGlyph[i]), this.palette.water, rippleAlpha[i] * this.cellDim[i]);
    }
  }

  /** Pellets fall in (' then .), land as o, bob while floating, then dim to . as they sink. */
  drawPellets(pond) {
    const { grid, cellH: ch } = this;
    for (const p of pond.pellets) {
      const age = pond.time - p.born;
      if (!p.landed) {
        const fall = age / p.landAt;
        // Drawn a little above where it will land, closing in as it drops.
        const i = this.cellIndex(p.x, p.y - (1 - fall) * ch * 1.5);
        if (i < 0 || grid.glyph[i]) continue;
        this.glyphAt(i, fall < 0.5 ? "'" : ".", this.palette.pellet,
          this.palette.alpha * (0.5 + 0.4 * fall) * this.cellDim[i]);
        continue;
      }
      const i = this.cellIndex(p.x, p.y);
      if (i < 0 || grid.glyph[i]) continue;
      const sink = smoothstep(PELLET_SINK, PELLET_LIFE, age);
      const bob = 0.8 + 0.2 * Math.sin(age * 3 + p.x);
      this.glyphAt(i, sink > 0.55 ? "." : "o", this.palette.pellet,
        this.palette.alpha * bob * (1 - 0.85 * sink) * this.cellDim[i]);
    }
  }

  drawCells() {
    const { ctx, grid, cellDim, cellW: cw, cellH: ch, cols } = this;
    for (let i = 0; i < grid.glyph.length; i++) {
      const code = grid.glyph[i];
      if (!code) continue;
      const x = (i % cols) * cw, y = ((i / cols) | 0) * ch;
      if (grid.tileAlpha[i] > 0) {
        ctx.globalAlpha = grid.tileAlpha[i] * cellDim[i];
        ctx.fillStyle = this.style(grid.tile[i]);
        ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      }
      if (code === 32) continue;
      ctx.globalAlpha = grid.alpha[i] * cellDim[i];
      ctx.fillStyle = this.style(grid.color[i]);
      ctx.fillText(String.fromCharCode(code), x + cw / 2, y + ch / 2 + 1);
    }
  }

  /** A bite flashes * over the mouth, settling to + then a dot as the splash takes over. */
  drawBites(pond) {
    for (const b of pond.bites) {
      const i = this.cellIndex(b.x, b.y);
      if (i < 0) continue;
      const t = (pond.time - b.born) / BITE_LIFE;
      const glyph = t < 0.35 ? "*" : t < 0.7 ? "+" : ".";
      this.glyphAt(i, glyph, this.palette.pellet, Math.min(1, this.palette.alpha * 1.6) * (1 - t * t) * this.cellDim[i]);
    }
  }
}
// ─── content boxes ──────────────────────────────────────────────────────────
const boxArea = (b) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
const unionArea = (a, b) =>
  (Math.max(a.right, b.right) - Math.min(a.left, b.left)) *
  (Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top));

function mergeNearby(boxes) {
  const merged = [];
  for (const b of [...boxes].sort((p, q) => p.top - q.top)) {
    let target = null;
    for (const m of merged) {
      if (!(b.top - m.bottom < MERGE_GAP_PX && b.left - m.right < MERGE_GAP_PX && m.left - b.right < MERGE_GAP_PX)) continue;
      // A full-width box (a nav bar) and a full-height one touch on both axes, but their union
      // is the whole viewport, which would dim every creature at once. Refuse that merge.
      if (unionArea(m, b) > MAX_MERGE_GROWTH * (boxArea(m) + boxArea(b))) continue;
      target = m;
      break;
    }
    if (!target) { merged.push({ ...b }); continue; }
    target.left = Math.min(target.left, b.left);
    target.right = Math.max(target.right, b.right);
    target.bottom = Math.max(target.bottom, b.bottom);
  }
  return merged;
}

/** Each line of visible text inside `selector` as its own viewport box; hidden cards and blank text don't count. */
function textBoxes(selector) {
  const out = [], range = document.createRange();
  if (!selector) return out;
  for (const root of document.querySelectorAll(selector)) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      if (!n.data.trim() || n.parentElement.closest('[aria-hidden="true"]')) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) out.push(r);
    }
  }
  return out;
}

// ─── mount ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
  /** Names from SPECIES, `{ type: "koi", count: 4 }`, or species objects. */
  species: ["koi"],
  /** "auto" follows the OS live; "dark" / "light" until setTheme() is called. */
  theme: "auto",
  /** Page content creatures steer around and fade under; null for none. */
  avoid: "[data-pond-avoid]",
  /** Clicks on these never feed. */
  ignore: "a, button, input, textarea, select, label, [data-pond-ignore]",
  /** Click the water to throw food. */
  feed: true,
  /** Full-viewport background (default when mounted on <body>), else fill the element. */
  fixed: undefined,
  /** Simulation speed; reduced motion multiplies it by 0.2. */
  speed: 1,
  /** Palette overrides: { dark: { page: [r, g, b], … }, light: { … } }. */
  palette: {},
  /** Called after every frame with the instance (e.g. to recolour text during a theme wipe). */
  onFrame: null,
};

function resolveSpecies(entry) {
  if (typeof entry === "object" && entry.step) return entry;
  const { type, ...config } = typeof entry === "string" ? { type: entry } : entry;
  const make = SPECIES[type];
  if (!make) throw new Error(`ascii-pond: unknown species "${type}" (have: ${Object.keys(SPECIES).join(", ")})`);
  return make(config);
}

/**
 * Start a pond in `target`: a <canvas> to draw into, or any element to put one in.
 * Returns { pond, renderer, canvas, feed(x, y), setTheme(isLight, at?), measure(), destroy() }.
 */
export function mount(target, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const species = o.species.map(resolveSpecies);
  const themes = {};
  for (const [name, base] of [["dark", DARK], ["light", LIGHT]]) {
    themes[name] = Object.assign({}, base, ...species.map((s) => s.colors?.[name]), o.palette[name]);
  }

  let canvas = target, owned = false;
  if (!(target instanceof HTMLCanvasElement)) {
    const fixed = o.fixed ?? (target === document.body || target === document.documentElement);
    canvas = document.createElement("canvas");
    owned = true;
    Object.assign(canvas.style, {
      display: "block", position: fixed ? "fixed" : "absolute", inset: "0",
      width: "100%", height: "100%", pointerEvents: "none",
    });
    if (!fixed && getComputedStyle(target).position === "static") target.style.position = "relative";
    target.prepend(canvas);
  }
  canvas.setAttribute("aria-hidden", "true");
  // In forced-colours mode the glyphs turn into unreadable blocks, and the pond is decoration.
  if (matchMedia("(forced-colors: active)").matches) canvas.style.display = "none";

  const pond = new Pond(species);
  const renderer = new PondRenderer(canvas, themes);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const prefersLight = matchMedia("(prefers-color-scheme: light)");
  let themeMode = o.theme;
  renderer.setTheme(themeMode === "auto" ? prefersLight.matches : themeMode === "light");

  /** Content creatures steer around and fade beneath. */
  function measure() {
    if (!renderer.cols) return;
    const origin = canvas.getBoundingClientRect();
    const toCanvas = (b) => ({ left: b.left - origin.left, top: b.top - origin.top, right: b.right - origin.left, bottom: b.bottom - origin.top });
    // Creatures steer around whole blocks, but only fade under the text itself: a block's box
    // spans the empty water beside its short lines too.
    pond.avoid = o.avoid ? mergeNearby(
      [...document.querySelectorAll(o.avoid)]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 1 && b.height > 1)
        .map(toCanvas)
    ) : [];
    // A box flush with the pond's edge (a nav bar) reaches on past it: a creature inside is then
    // pushed back into the water, not out through the nearest edge, which is off-screen.
    for (const b of pond.avoid) {
      if (b.left <= 1) b.left = -1e4;
      if (b.top <= 1) b.top = -1e4;
      if (b.right >= pond.width - 1) b.right = 1e4;
      if (b.bottom >= pond.height - 1) b.bottom = 1e4;
    }
    renderer.setDimBoxes(textBoxes(o.avoid).map(toCanvas));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
    pond.resize(rect.width, rect.height);
    measure();
  }

  function toLocal(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
  }

  let lastTouchRipple = 0;
  function onMove(e) {
    const { x, y, inside } = toLocal(e);
    // A finger has no hover, so it leaves ripples behind it instead.
    if (e.pointerType === "touch" && inside && e.timeStamp - lastTouchRipple > 60) {
      lastTouchRipple = e.timeStamp;
      if (renderer.cellIndex(x, y) >= 0 && renderer.cellDim[renderer.cellIndex(x, y)] > 0.9) {
        pond.ripples.push({ x, y, born: pond.time, strength: 0.18 });
      }
    }
    const p = pond.pointer;
    p.x = x; p.y = y;
    p.active = inside && e.pointerType !== "touch";
  }

  function onClick(e) {
    if (!o.feed) return;
    if (e.composedPath().some((n) => n instanceof Element && n.matches(o.ignore))) return;
    if (window.getSelection()?.toString()) return;
    // A click on the words themselves is a click on the copy; the empty water beside a line is still pond.
    const slop = 4;
    if (textBoxes(o.avoid).some((r) => e.clientX > r.left - slop && e.clientX < r.right + slop && e.clientY > r.top - slop && e.clientY < r.bottom + slop)) return;
    const { x, y, inside } = toLocal(e);
    if (!inside) return;
    pond.feed(x, y);
  }

  const calm = () => { pond.pointer.active = false; };
  const onOsTheme = () => { if (themeMode === "auto") renderer.setTheme(prefersLight.matches); };

  let last = performance.now(), acc = 0, wakeAcc = 0, measured = 0, running = true, scrolled = false;
  // Copy moves under a fixed pond on scroll: re-measure on the next frame, not the next periodic one.
  const onScroll = () => { scrolled = true; };
  const instance = {
    pond, renderer, canvas,
    feed: (x, y) => pond.feed(x, y),
    measure,
    /** Switch theme; with `at` ({ x, y } in canvas pixels) as a circular wipe from there. */
    setTheme(isLight, at) {
      themeMode = isLight ? "light" : "dark";
      if (at && !reducedMotion.matches) renderer.startReveal(at.x, at.y, isLight ? themes.light : themes.dark);
      else renderer.setTheme(isLight);
    },
    destroy() {
      running = false;
      observer.disconnect();
      removeEventListener("pointermove", onMove);
      removeEventListener("click", onClick);
      removeEventListener("blur", calm);
      removeEventListener("scroll", onScroll, { capture: true });
      document.documentElement.removeEventListener("pointerleave", calm);
      prefersLight.removeEventListener("change", onOsTheme);
      if (owned) canvas.remove();
    },
  };

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // Reduced motion keeps the pond alive but at a fifth of the speed.
    acc += dt * o.speed * (reducedMotion.matches ? 0.2 : 1);
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) { pond.step(STEP); acc -= STEP; steps++; }
    if (steps === MAX_STEPS) acc = 0;
    wakeAcc += steps * STEP;
    for (; wakeAcc >= WAKE_STEP; wakeAcc -= WAKE_STEP) {
      if (renderer.energy) { renderer.depositWake(pond); renderer.diffuse(WAKE_STEP); }
    }
    if (++measured % MEASURE_EVERY_FRAMES === 0 || scrolled) { scrolled = false; measure(); }
    renderer.render(pond);
    o.onFrame?.(instance);
    requestAnimationFrame(frame);
  }

  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("click", onClick);
  addEventListener("blur", calm);
  // Capture: scroll doesn't bubble, and inner scrolling panes move copy too.
  addEventListener("scroll", onScroll, { passive: true, capture: true });
  document.documentElement.addEventListener("pointerleave", calm);
  prefersLight.addEventListener("change", onOsTheme);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  requestAnimationFrame(frame);
  return instance;
}

// ─── <ascii-pond> ───────────────────────────────────────────────────────────
/**
 * <ascii-pond species="koi" count="5" young="0" theme="auto|dark|light" avoid="selector" fixed no-feed>
 * Without `fixed` it fills itself, so give it a size.
 */
class AsciiPondElement extends HTMLElement {
  connectedCallback() {
    if (this.instance) return;
    const attr = (n) => this.getAttribute(n);
    // Numbers given here go to every species listed.
    const config = {};
    for (const n of ["count", "young"]) if (this.hasAttribute(n)) config[n] = Number(attr(n));
    if (!this.style.display) this.style.display = "block";
    this.instance = mount(this, {
      species: (attr("species") || "koi").split(",").map((type) => ({ type: type.trim(), ...config })),
      theme: attr("theme") || "auto",
      ...(this.hasAttribute("avoid") ? { avoid: attr("avoid") || null } : {}),
      feed: !this.hasAttribute("no-feed"),
      fixed: this.hasAttribute("fixed"),
    });
  }
  disconnectedCallback() {
    this.instance?.destroy();
    this.instance = null;
  }
}
if (!customElements.get("ascii-pond")) customElements.define("ascii-pond", AsciiPondElement);
