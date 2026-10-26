// The koi: a 20-node spine that each screen cell is projected onto, drawn as glyph tiles.
// A species module for the pond engine (see `species` in pond.js for the interface).
import {
  TAU, clamp, rand, smoothstep, angleDiff, mix, shade, ramp, packRgb, hash3, valueNoise, lineGlyph, repel, compact,
} from "./util.js";

// ─── constants ──────────────────────────────────────────────────────────────
const TILE_GLYPHS = "t%SX8@#";              // dense in shadow, sparse in light
const SUBSAMPLES = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];
const NODES = 20;                            // spine samples, snout first
const BODY_END = 0.74;                       // body/tail break, fraction of length
/** Most a spine joint may bend, in radians: a shape limit, not a rate, so it doesn't scale with STEP. */
const MAX_BEND = 0.16;

const MAX_KOI = 8;                           // a bigger window may add koi, up to this
const RUSH_RANGE = 650;                      // koi inside this range bolt for a splash
const GLIDE_DRAG = 0.45;                     // 1/s: a coasting koi loses half its speed in ~1.5 s
const FULL_BEAT = 5;                         // a full tail beat holds this many × cruise speed

/**
 * What an idle koi is up to: [name, weight by energy, seconds, speed × cruise]. Each koi picks
 * its next mood at random, never the one it just had, so no two koi keep the same rhythm.
 */
const MOODS = [
  ["cruise",  (e) => 3,       [6, 18], [0.75, 1.05]],
  ["glide",   (e) => 2,       [5, 14], [0.7, 1]],      // stroke, coast, stroke: irregular
  ["explore", (e) => 2.4 * e, [8, 20], [1, 1.4]],      // a long run to a far point of the pond
  ["rest",    (e) => 1.6 / e, [4, 12], [0.12, 0.3]],   // hangs deep, barely moving
  ["surface", (e) => 1,       [4, 10], [0.3, 0.55]],   // noses along the top, mouthing it
  ["follow",  (e) => 1.2,     [6, 15], [0.9, 1.2]],    // trails a neighbour for a while
  ["search",  (e) => 0,       [3, 9],  [0.9, 1.3]],    // after food: mills about where it was
];

// what a body point is
const F_BODY = 1, F_FIN = 2, F_EYE = 3, F_BARBEL = 4;

/** Koi colours per theme, merged into the pond's palette (keys must not clash with other species). */
const COLORS = {
  dark: {
    white: [236, 228, 218],
    red: [232, 96, 56],
    black: [92, 90, 108],
    fin: [214, 206, 198],
    eye: [20, 20, 26],
    /** Hi: the red-orange of koi markings, deep shadow to lit highlight. */
    hi: [[112, 22, 24], [168, 34, 28], [214, 58, 30], [240, 96, 34], [250, 138, 52], [255, 178, 96]],
  },
  light: {
    white: [112, 108, 104],
    red: [204, 62, 28],
    black: [36, 33, 40],
    fin: [138, 132, 126],
    eye: [24, 22, 26],
    hi: [[138, 24, 22], [184, 38, 24], [222, 62, 28], [238, 100, 38], [244, 140, 66], [248, 176, 116]],
  },
};


// ─── outline: everything as a fraction of body length ───────────────────────
/** Top-down half width: blunt round head, plump shoulders, narrow tail stalk. */
function halfWidth(s) {
  if (s < 0.12) return 0.11 * Math.pow(Math.sin((s / 0.12) * Math.PI / 2), 0.55);
  if (s < 0.30) return 0.11 + 0.025 * smoothstep(0.12, 0.30, s);
  return 0.033 + 0.102 * (1 - smoothstep(0.30, BODY_END, s));
}
/** Butterfly tail: fans out from the stalk, V notch in the trailing edge. */
const tailHalfWidth = (s) => 0.03 + 0.15 * Math.pow(smoothstep(0.7, 1, s), 0.8);

/**
 * The fin geometry that depends only on a koi's flare, computed once per koi per
 * frame: the same two ellipses turned into their axes.
 */
function finProfile(flare) {
  const a1 = 0.85 + 0.5 * (flare - 1);
  return {
    flare,
    c1: Math.cos(a1), s1: Math.sin(a1), r1: 0.066 * flare,
    c2: Math.cos(0.75), s2: Math.sin(0.75), r2: 0.036,
  };
}

/** Test a point against a fin: an ellipse leaning back from a root on the body's edge. */
function inFin(s, a, rootS, reach, width, cosA, sinA) {
  const rootA = halfWidth(rootS) * 0.85;
  const du = s - rootS, da = a - rootA;
  const along = du * cosA + da * sinA - reach;
  const perp = -du * sinA + da * cosA;
  return (along / reach) ** 2 + (perp / width) ** 2 <= 1;
}

/**
 * Classify a point in body coordinates, all fractions of length: `s` along the
 * spine (0 snout, 1 tail tip), `a` distance from it, `past` beyond the tail tip,
 * `ahead` before the snout, `lateral` sideways distance off the snout. `flare`
 * spreads the fins. Writes into `out` and returns whether the point is on the koi.
 */
function classify(s, a, past, profile, out, ahead = 0, lateral = 0) {
  out.flag = 0;
  out.across = 1;

  // Barbels: a short whisker angling out from each corner of the mouth.
  if (ahead > 0) {
    if (ahead < 0.05 && Math.abs(lateral - (0.045 + ahead * 0.7)) < 0.016) {
      out.flag = F_BARBEL;
      return true;
    }
    return false;
  }

  const w = halfWidth(s);
  if (s <= BODY_END && a <= w) {
    const across = a / w;
    out.across = across;
    out.flag = (s > 0.055 && s < 0.1 && across > 0.5 && across < 0.85) ? F_EYE : F_BODY;
    return true;
  }

  if (s > 0.68 && past <= 0) {
    const tw = tailHalfWidth(s) * profile.flare;
    if (a <= tw && s <= 0.86 + 0.14 * (a / tw)) {
      out.flag = F_FIN;
      out.across = 1;
      return true;
    }
  }

  const fin = inFin(s, a, 0.19, profile.r1, 0.04, profile.c1, profile.s1)
           || inFin(s, a, 0.47, profile.r2, 0.018, profile.c2, profile.s2);
  if (fin) { out.flag = F_FIN; out.across = 1; }
  return fin;
}

// ─── markings ───────────────────────────────────────────────────────────────
/** A marking in body space: centred at (s, v) along/across the spine, as fractions of length. */
const inPatch = (m, s, vn, wobble) =>
  ((s - m.s) / m.rs) ** 2 + ((vn - m.v) / m.rv) ** 2 < 1 + wobble;

/**
 * Each koi gets a fixed set of markings, seeded by its id: kohaku a red head and
 * two or three red saddles on white, sanke the same plus small black spots,
 * tancho a single red disc on the crown.
 */
function koiMarkings(k) {
  const r = (j) => hash3(k.id, j, 41);
  if (k.variety === "tancho") return { red: [{ s: 0.11, v: 0, rs: 0.05, rv: 0.055 }], black: [] };

  const red = [];
  if (r(0) < 0.75) red.push({ s: 0.1, v: (r(1) - 0.5) * 0.03, rs: 0.055 + r(2) * 0.03, rv: 0.11 });
  const saddles = 2 + Math.floor(r(3) * 2);
  for (let j = 0; j < saddles; j++) {
    const span = 0.42 / saddles;
    red.push({
      s: 0.25 + span * (j + 0.5) + (r(10 + j) - 0.5) * span * 0.3,
      v: (r(20 + j) - 0.5) * 0.05,
      rs: span * (0.32 + r(30 + j) * 0.12),
      rv: 0.09 + r(40 + j) * 0.05,
    });
  }

  const black = [];
  if (k.variety === "sanke") {
    const spots = 4 + Math.floor(r(50) * 3);
    for (let j = 0; j < spots; j++) {
      black.push({ s: 0.24 + r(60 + j) * 0.44, v: (r(70 + j) - 0.5) * 0.16, rs: 0.022, rv: 0.026 });
    }
  }
  return { red, black };
}

// ─── pond: the simulation ───────────────────────────────────────────────────
const VARIETIES = [["kohaku", 3], ["sanke", 2], ["tancho", 1]];
const VARIETY_WEIGHT = VARIETIES.reduce((sum, [, w]) => sum + w, 0);
function pickVariety() {
  let r = Math.random() * VARIETY_WEIGHT;
  for (const [variety, w] of VARIETIES) { r -= w; if (r <= 0) return variety; }
  return "kohaku";
}

// ─── life ───────────────────────────────────────────────────────────────────
/** Add one koi; `offscreen` starts it just outside the edge, heading in. */
function spawn(pond, species, { young = false, offscreen = false } = {}) {
  const W = pond.width, H = pond.height;
  const baseLength = clamp(Math.min(W, H) * 0.5, 170, 420);
  const length = baseLength * (young ? rand(0.32, 0.45) : rand(0.6, 1));
  const depthMax = young ? 0.72 : 1;
  const seg = length / (NODES - 1);
  let x = rand(W * 0.1, W * 0.9), y = rand(H * 0.1, H * 0.9), heading = rand(0, TAU);
  if (offscreen) {
    // Enter from the nearest edge, pointing inwards.
    const edge = Math.floor(rand(0, 4));
    if (edge === 0) { x = -length * 0.6; y = rand(H * 0.2, H * 0.8); heading = 0; }
    else if (edge === 1) { x = W + length * 0.6; y = rand(H * 0.2, H * 0.8); heading = Math.PI; }
    else if (edge === 2) { x = rand(W * 0.2, W * 0.8); y = -length * 0.6; heading = Math.PI / 2; }
    else { x = rand(W * 0.2, W * 0.8); y = H + length * 0.6; heading = -Math.PI / 2; }
  }
  const nodes = new Float32Array(NODES * 2);
  for (let n = 0; n < NODES; n++) {
    nodes[n * 2] = x - Math.cos(heading) * seg * n;
    nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
  }
  pond.creatures.push({
    species,
    id: pond.nextId++,
    variety: pickVariety(),
    length,
    nodes,
    heading,
    speed: 20,
    phase: rand(0, TAU),
    turn: 0,
    wander: 0,
    curiosity: rand(0.35, 1),
    energy: rand(0.7, 1.3),
    tempo: rand(0.88, 1.12),
    appetite: rand(0.55, 1),
    // A fresh pond hasn't been fed yet, so the first handful gets a real rush; eating spreads them out.
    hunger: rand(0.65, 1),
    mood: "cruise",
    moodUntil: rand(2, 8),
    vMood: 1,
    pace: 0,
    goalX: 0,
    goalY: 0,
    goalAt: 0,
    foodX: 0,
    foodY: 0,
    follow: null,
    stroking: true,
    coastLo: 0.7,
    coastHi: 1.2,
    dashUntil: 0,
    dashV: 2,
    nextDash: rand(15, 60),
    turnRate: 0,
    wasChasing: false,
    depth: rand(0.5, depthMax),
    depthTarget: rand(0.5, depthMax),
    depthMax,
    young,
    leaving: false,
    nextDive: rand(6, 18),
    nextSurface: rand(3, 14),
    nextWake: rand(0, 2),
    rush: 0,
    reactAt: 0,
    drive: 0,
    deaf: 0,
    food: null,
    beat: 0,
    finPhase: rand(0, TAU),
    startle: 0,
    nextSpook: rand(60, 300),
    fleeX: 0,
    fleeY: 0,
    gulp: 0,
    spine: new Float32Array(NODES * 2),
    arc: new Float32Array(NODES),
    arcTotal: 1,
    segHalf: 0,
    flareLeft: 1,
    flareRight: 1,
  });
}

/** How many koi a pond of this size holds: `count` adults (auto: 3–6 by area), plus `young`. */
function wanted(pond, { count = "auto", young = "auto" }) {
  const adults = count === "auto" ? clamp(Math.round((pond.width * pond.height) / 240000), 3, 6) : count;
  // Wide screens also get a couple of young koi that keep to the deep water, for depth.
  const juveniles = young === "auto" ? (pond.width >= 1024 ? 2 : 0) : young;
  return { adults, juveniles };
}

function seed(pond, species, config) {
  const { adults, juveniles } = wanted(pond, config);
  for (let i = 0; i < adults + juveniles; i++) spawn(pond, species, { young: i >= adults });
}

/**
 * The window settled at a new size: koi swim in or out to suit it, never popping. Leavers are
 * called back first; new koi start off-screen; extras, the ones nearest an edge and not after
 * food, head off it and are dropped once out of sight.
 */
function grow(pond, species, config) {
  const { max = MAX_KOI } = config;
  const want = wanted(pond, config);
  let room = max - pond.creatures.filter((c) => c.species === species && !c.leaving).length;
  for (const young of [false, true]) {
    const mine = pond.creatures.filter((c) => c.species === species && c.young === young);
    const staying = mine.filter((c) => !c.leaving);
    let need = (young ? want.juveniles : want.adults) - staying.length;
    for (const k of mine) if (need > 0 && room > 0 && k.leaving) { k.leaving = false; need--; room--; }
    for (; need > 0 && room > 0; need--, room--) spawn(pond, species, { young, offscreen: true });
    const edge = (k) => Math.min(k.nodes[0], pond.width - k.nodes[0], k.nodes[1], pond.height - k.nodes[1]) + (k.food ? 1e4 : 0);
    staying.sort((a, b) => edge(a) - edge(b));
    for (let i = 0; i < -need; i++) { staying[i].leaving = true; setMood(pond, staying[i], "cruise"); }
  }
}

/**
 * A pellet hit the water. The splash is what koi react to: everyone in range bolts for it, each
 * after its own beat — nearer and bolder koi first — so the pond doesn't jump as one.
 */
function splash(pond, species, p) {
  const t = pond.time;
  let nearest = null, nearestD = Infinity;
  for (const k of pond.creatures) {
    if (k.species !== species) continue;
    const d = Math.hypot(k.nodes[0] - p.x, k.nodes[1] - p.y);
    if (d < nearestD) { nearest = k; nearestD = d; }
    if (d >= RUSH_RANGE) continue;
    if (k.food) k.rush = Math.max(k.rush, k.appetite * k.hunger);
    else if (k.reactAt <= t && t > k.deaf) {
      // How much it wants this handful: appetite, how much it has just eaten, and the moment.
      const drive = clamp(k.appetite * k.hunger * rand(0.75, 1.2), 0, 1);
      // One far, full or idle may let it go; it still takes food it swims past.
      if (drive < 0.4 && d > RUSH_RANGE * 0.3 && Math.random() < 0.7) { k.deaf = t + rand(4, 10); continue; }
      // Hungry koi turn at once; the less it wants it, the longer it takes to bother.
      k.drive = drive;
      k.reactAt = t + 0.12 + 0.5 * (d / RUSH_RANGE) + 1.2 * (1 - drive) + 0.3 * (1 - k.curiosity) + (k.mood === "rest" ? 0.4 : 0) + rand(0, 0.45) + Math.random() ** 3 * 0.8;
    }
  }
  // Nobody within earshot: the nearest koi still comes, a beat later, so a throw is never ignored.
  if (nearest && nearestD >= RUSH_RANGE && !nearest.food && nearest.reactAt <= t) nearest.reactAt = t + 0.7;
}

/** Food left floating catches someone's eye sooner or later: the nearest koi not already after some. */
function floating(pond, species, p) {
  const t = pond.time;
  if (!p.noticed && t - p.born > 6 && !pond.creatures.some((k) => k.species === species && k.food === p)) {
    p.noticed = true;
    let idle = null, idleD = Infinity;
    for (const k of pond.creatures) {
      if (k.species !== species) continue;
      const d = Math.hypot(k.nodes[0] - p.x, k.nodes[1] - p.y);
      if (!k.food && d < idleD) { idle = k; idleD = d; }
    }
    if (idle) { idle.reactAt = t + 0.3; idle.deaf = 0; }
  }
}

function step(pond, k, dt) {
  const W = pond.width, H = pond.height, pointer = pond.pointer, time = pond.time;
  const L = k.length, nodes = k.nodes;
  const hx = nodes[0], hy = nodes[1];
  const cruise = 12 + L * 0.05;

  let dx = Math.cos(k.heading), dy = Math.sin(k.heading);
  // A random walk: its step scales with √dt, so the wander is the same at any STEP.
  k.wander = clamp(k.wander + (Math.random() - 0.5) * 2.4 * Math.sqrt(dt / 60), -0.9, 0.9);
  const roam = k.mood === "explore" ? 0.35 : k.mood === "surface" ? 0.9 : 0.6;
  dx += Math.cos(k.heading + k.wander) * roam;
  dy += Math.sin(k.heading + k.wander) * roam;

  // How hard it goes for food is its own: appetite, and how much it has just eaten.
  if (k.reactAt && time >= k.reactAt) { k.rush = Math.max(k.rush, k.drive); k.reactAt = 0; }
  k.hunger = Math.min(1, k.hunger + dt / 90);
  // Until its reaction lands, a koi hasn't noticed the food yet.
  // A koi that heard a splash looks across the whole pond.
  // One not in the mood only takes food that comes right past its nose.
  const food = k.leaving || k.reactAt > time ? null
    : pickFood(pond, k, hx, hy, k.rush > 0 || k.mood === "search" ? Math.hypot(W, H) : time < k.deaf ? L * 0.6 : L * 1.6 + 220);

  // Every few minutes something unseen (a shadow, a sound) spooks a koi; one with food on its mind ignores it.
  if (time > k.nextSpook) {
    k.nextSpook = time + rand(120, 360);
    if (!food && !k.reactAt && k.mood !== "search") { const a = rand(0, TAU); spook(pond, k, hx + Math.cos(a) * L * 0.5, hy + Math.sin(a) * L * 0.5); }
  }
  k.startle = Math.max(0, k.startle - dt * 0.6);
  const fleeing = k.startle > 0.3 && !food;

  let chasing = false, curious = false, closing = 0, far = 0, first = false, rival = false;
  if (fleeing) {
    const ox = hx - k.fleeX, oy = hy - k.fleeY, d = Math.hypot(ox, oy) || 1;
    dx += (ox / d) * 4 * k.startle;
    dy += (oy / d) * 4 * k.startle;
  } else if (food) {
    const tx = food.x - hx, ty = food.y - hy, d = Math.hypot(tx, ty) || 1;
    closing = clamp(1 - d / (L * 1.2), 0, 1);
    // The pull grows as it closes in, so jostling neighbours can't keep turning it off the pellet.
    dx += (tx / d) * (3 + 4 * closing);
    dy += (ty / d) * (3 + 4 * closing);
    chasing = true;
    far = clamp((d - L) / (L * 2), 0, 1);
    // Of all the koi after this pellet, the nearest shoulders through the scrum to take it.
    first = !pond.creatures.some((o) => o !== k && o.species === k.species && o.food === food && Math.hypot(food.x - o.nodes[0], food.y - o.nodes[1]) < d);
    // Another koi about as close is after the same pellet: a race.
    rival = pond.creatures.some((o) => o !== k && o.species === k.species && o.food === food &&
      Math.abs(Math.hypot(food.x - o.nodes[0], food.y - o.nodes[1]) - d) < d * 0.5 + L * 0.3);
  } else if (pointer.active) {
    const tx = pointer.x - hx, ty = pointer.y - hy, d = Math.hypot(tx, ty) || 1;
    const range = 300;
    if (d < range) {
      // Swim up to the cursor, then circle under it rather than parking.
      const w = k.curiosity * (1 - d / range) * 2.2;
      const near = clamp(d / (L * 0.6), 0, 1);
      dx += ((tx / d) * near - (ty / d) * (1 - near)) * w;
      dy += ((ty / d) * near + (tx / d) * (1 - near)) * w;
      curious = true;
    }
  }
  if (!fleeing && !food && !k.leaving) {
    if (time > k.moodUntil) setMood(pond, k, pickMood(k));
    const goal = moodGoal(pond, k);
    if (goal) {
      const tx = goal.x - hx, ty = goal.y - hy, d = Math.hypot(tx, ty) || 1;
      dx += (tx / d) * 1.3;
      dy += (ty / d) * 1.3;
    }
  }

  for (const other of pond.creatures) {
    if (other === k || other.species !== k.species) continue;
    const ohx = other.nodes[0], ohy = other.nodes[1];
    if (Math.abs(ohx - hx) > L * 2 || Math.abs(ohy - hy) > L * 2) continue;
    // Body against body: push away along the deepest overlap only. Summing every close
    // pair let distant contacts cancel the near ones out, so the koi still swam through
    // each other; the single worst contact always wins.
    // Only the front half of the body steers: a contact behind the head would only make
    // the koi turn back and forth as the other one passes.
    let worst = 0, nx = 0, ny = 0;
    for (let i = 0; i < NODES * 0.6; i += 2) {
      const mx = nodes[i * 2], my = nodes[i * 2 + 1];
      const myR = halfWidth(i / (NODES - 1)) * L;
      for (let n = 0; n < NODES; n += 2) {
        const ox = mx - other.nodes[n * 2], oy = my - other.nodes[n * 2 + 1];
        const d = Math.hypot(ox, oy) || 1e-3;
        // Koi going for food jostle in close, so personal space shrinks.
        const clearance = (myR + halfWidth(n / (NODES - 1)) * other.length) * (food ? 1.1 : 1.5);
        const pen = 1 - d / clearance;
        if (pen > worst) { worst = pen; nx = ox / d; ny = oy / d; }
      }
    }
    if (worst > 0) {
      const push = worst * (food ? (first ? 1 : 4) : 3);
      dx += nx * push;
      dy += ny * push;
    }
    // Loose shoaling: nearby koi drift the same way.
    if (!chasing && Math.hypot(ohx - hx, ohy - hy) < L * 1.6) {
      dx += Math.cos(other.heading) * 0.18;
      dy += Math.sin(other.heading) * 0.18;
    }
  }

  // One the pond no longer has room for heads out over the nearest edge; out of sight, it's gone.
  if (k.leaving) {
    const edges = [[hx, -1, 0], [W - hx, 1, 0], [hy, 0, -1], [H - hy, 0, 1]];
    const [, ox, oy] = edges.reduce((a, b) => (b[0] < a[0] ? b : a));
    const m = L * 0.15;
    let seen = false;
    for (let n = 0; n < NODES && !seen; n++) {
      const x = nodes[n * 2], y = nodes[n * 2 + 1];
      seen = x > -m && x < W + m && y > -m && y < H + m;
    }
    if (!seen) k.gone = true;
    dx += ox * 3;
    dy += oy * 3;
  }
  // Walls: look ahead and turn along them in good time, so a koi wide-arcs round rather than
  // ploughing off-screen; past the edge it always heads back in.
  // Food by the edge still gets taken: a koi after it looks less far ahead.
  const look = L * (chasing ? 0.3 : curious ? 0.5 : 0.6);
  const ax = hx + Math.cos(k.heading) * look, ay = hy + Math.sin(k.heading) * look;
  const ex = Math.max(0, -ax) - Math.max(0, ax - W), ey = Math.max(0, -ay) - Math.max(0, ay - H);
  const wall = k.leaving ? 0 : clamp(Math.hypot(ex, ey) / (L * 0.6), 0, 1);
  if (wall > 0) {
    const d = Math.hypot(ex, ey), nx = ex / d, ny = ey / d;
    // Turn the way it already leans, so a head-on approach doesn't dither left and right.
    const side = Math.sign(-ny * Math.cos(k.heading) + nx * Math.sin(k.heading) || k.wander) || 1;
    dx += (nx - ny * side * 0.6) * wall * 3;
    dy += (ny + nx * side * 0.6) * wall * 3;
  }
  const over = Math.max(-hx, hx - W, -hy, hy - H);
  if (over > 0 && !k.leaving) {
    const w = clamp(over / (L * 0.3), 0, 1) * 3.5;
    const toX = W / 2 - hx, toY = H / 2 - hy, d = Math.hypot(toX, toY) || 1;
    dx += (toX / d) * w;
    dy += (toY / d) * w;
  }
  // Drift around page content rather than under it; food and the cursor can still lure them
  // across. Near a wall the wall wins: content close to an edge used to pin koi half off-screen.
  repel(pond.avoid, hx, hy, L * 0.4, PUSH);
  const yieldTo = (chasing || curious ? 0.5 : 1.8) * (over > 0 ? 0 : 1 - wall);
  dx += PUSH.x * yieldTo;
  dy += PUSH.y * yieldTo;

  const desired = Math.atan2(dy, dx);
  // Long bodies can't pivot on the spot: the turning circle grows with length. A cruising koi
  // turns on a wide arc (radius ~0.9 L, tighter near a wall); a fixed L/4 for every mood kept every koi coiled in the
  // same tight C. Purpose tightens it: curiosity, food, fear. And the first instant of a scare
  // snaps round, and a koi braking onto food can tuck in tighter still.
  // The turn rate eases toward one proportional to how far off course it is, so small
  // corrections are gentle arcs and nothing snaps between hard-over and straight.
  const radius = (fleeing ? 0.25 : chasing ? 0.33 : curious ? 0.55 : 0.9 - 0.3 * wall) / (1 + k.rush * 0.6);
  const cStart = fleeing && k.startle > 0.8;
  const maxRate = cStart ? 7 : Math.min((fleeing ? 3 : chasing ? 1.9 + closing : curious ? 1.2 : 0.7) * (1 + k.rush * 0.6),
    k.speed / (radius * L) + closing * 1.2);
  let err = angleDiff(k.heading, desired);
  // Already swinging round through a U-turn: carry on that way rather than reverse.
  if (Math.abs(err) > 2.6 && k.turnRate * err < 0 && Math.abs(k.turnRate) > 0.02) err -= Math.sign(err) * TAU;
  // Homing on food is the one place it steers hard: a soft lag there leaves it circling a pellet.
  const wantRate = maxRate * clamp(err / (chasing ? 0.25 : 0.6), -1, 1);
  if (cStart) k.turnRate = wantRate;
  else k.turnRate += (wantRate - k.turnRate) * Math.min(1, dt * (chasing ? 12 : fleeing ? 6 : 2.5));
  const turned = clamp(k.turnRate * dt, -Math.abs(err), Math.abs(err));
  k.heading += turned;
  k.turn += (turned / dt - k.turn) * Math.min(1, dt * 3);
  if (k.wasChasing && !chasing && !fleeing) {
    setMood(pond, k, "search");
    // The food is gone, but it carries on a moment at the pace it had, each for its own while.
    k.dashUntil = time + rand(0.2, 1.5);
    k.dashV = (k.speed / cruise) * rand(0.7, 1);
  }
  // Spotting food on its own (searching, or passing by) perks it up as much as a splash would.
  if (chasing && !k.wasChasing) k.rush = Math.max(k.rush, k.appetite * k.hunger * 0.8);
  k.wasChasing = chasing;
  if (food) { k.foodX = food.x; k.foodY = food.y; }

  // A now-and-then dash out of its own accord: a few hard strokes, then a long glide.
  const calm = !fleeing && !chasing && k.mood !== "rest" && k.mood !== "surface";
  if (time > k.nextDash) {
    if (calm) { k.dashUntil = time + rand(1.2, 3); k.dashV = rand(1.8, 2.6); }
    k.nextDash = time + rand(25, 80) / k.energy;
  }
  const dashing = calm && time < k.dashUntil;
  // Tail beats near the surface push small rings out behind the koi.
  if (k.beat > 0.6 && k.depth > 0.65 && time > k.nextWake) {
    const tail = (NODES - 3) * 2;
    pond.ripples.push({ x: nodes[tail], y: nodes[tail + 1], born: time, strength: 0.25 + 0.2 * k.depth });
    k.nextWake = time + rand(0.8, 1.6) / k.beat;
  }
  // The excitement holds for as long as it is chasing food, lingers while it searches, then fades.
  if (!chasing) k.rush = Math.max(0, k.rush - dt * (k.mood === "search" ? 0.15 : 0.7));

  // Speed comes from the tail: each beat pushes, the water drags. Cruising is a steady easy
  // beat, not on-off; the speed it wants also drifts slowly, so it never holds one pace.
  k.pace = clamp(k.pace * (1 - dt / 5) + (Math.random() - 0.5) * 0.4 * Math.sqrt(dt), -0.25, 0.25);
  const aligned = 1 - smoothstep(0.2, 0.7, Math.abs(err));
  const target = Math.min(FULL_BEAT, fleeing ? 3.2 * (1 + k.rush * 0.8)
    // A hungry koi bolts (~4× cruise), a full one ambles over (~1.3×); a race speeds both up. Close
    // in, lined up, it lunges to take it; off to one side, it slows to turn in on it.
    : chasing ? (1.2 + 3 * k.rush * k.rush) * (1 + 0.3 * far) * (rival ? 1.35 : 1) *
      (1 + 0.4 * closing * aligned * k.rush) * (1 - 0.6 * closing * (1 - aligned))
    : dashing ? k.dashV
    // A slow koi at a wall picks up speed to turn: it can only turn as fast as it swims.
    : Math.max(curious ? 1.3 : 0, over > 0 ? 1 : 0.9 * wall, k.vMood * (1 + k.pace) * (1 + k.rush * 0.5))) * cruise;
  // Hard strokes bite harder and the water pushes back harder at speed: a koi in a hurry gets
  // up to speed (and sheds it) in a fraction of a second, a calm one over a couple of seconds.
  const urgent = fleeing || chasing || dashing, drag = GLIDE_DRAG * (fleeing || chasing ? 4 : dashing ? 2 : 1), thrust = drag * cruise * FULL_BEAT;
  let want = clamp((drag * target + (urgent ? 2 : 0.6) * (target - k.speed)) / thrust, 0, 1);
  if (k.mood === "glide" && !urgent && !curious) {
    // Burst and coast, with every stroke and glide its own length.
    if (k.stroking && k.speed > target * k.coastHi) { k.stroking = false; k.coastLo = rand(0.55, 0.85); }
    else if (!k.stroking && k.speed < target * k.coastLo) { k.stroking = true; k.coastHi = rand(1.1, 1.35); }
    want = k.stroking ? clamp((GLIDE_DRAG + 0.6) * target * 1.4 / thrust - 0.6 * k.speed / thrust, 0, 0.45) : 0;
  }
  k.beat += (want - k.beat) * Math.min(1, dt * (want < k.beat ? 2 : fleeing ? 12 : chasing ? 1.5 + 3 * k.rush : dashing ? 2.2 : 1.2));
  // Pectorals spread to brake hard when it overshoots what it wants.
  const brake = k.speed > target * 1.3 ? (urgent ? 1.6 : 0.25) : 0;
  k.speed = Math.max(0, k.speed + (thrust * k.beat - (drag + brake) * k.speed) * dt);
  // Each koi beats its tail at its own tempo, so two pacing together still drift out of step.
  k.phase += dt * (0.6 + k.beat * (2.2 + k.speed / 11)) * k.tempo;
  k.finPhase += dt * 2.4;
  k.gulp += ((chasing && closing > 0.55 ? 1 : 0) - k.gulp) * Math.min(1, dt * 6);

  // Koi drift between the deep and the surface, and rise for food.
  if (time > k.nextDive) {
    k.depthTarget = rand(0.5, k.depthMax);
    k.nextDive = time + rand(8, 20);
  }
  k.depth += ((chasing ? 1 : k.depthTarget) - k.depth) * Math.min(1, dt * (chasing ? 0.8 : 0.15));

  nodes[0] += Math.cos(k.heading) * k.speed * dt;
  nodes[1] += Math.sin(k.heading) * k.speed * dt;

  // Follow-the-leader: each node trails the one ahead, bending no more than maxBend.
  const seg = L / (NODES - 1), maxBend = MAX_BEND;
  let prevAngle = k.heading + Math.PI;
  for (let n = 1; n < NODES; n++) {
    const px = nodes[(n - 1) * 2], py = nodes[(n - 1) * 2 + 1];
    let angle = Math.atan2(nodes[n * 2 + 1] - py, nodes[n * 2] - px);
    angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
    nodes[n * 2] = px + Math.cos(angle) * seg;
    nodes[n * 2 + 1] = py + Math.sin(angle) * seg;
    prevAngle = angle;
  }

  // Koi feed by suction: food at the lips goes in, and so does food a little further out dead ahead.
  const mouthR = L * 0.08 + 6, before = pond.pellets.length, fx = Math.cos(k.heading), fy = Math.sin(k.heading);
  compact(pond.pellets, (p) => {
    if (!p.landed) return true;
    const ox = p.x - nodes[0], oy = p.y - nodes[1], d2 = ox * ox + oy * oy;
    return d2 > mouthR * mouthR && !(d2 < 2.25 * mouthR * mouthR && ox * fx + oy * fy > 0.8 * Math.sqrt(d2));
  });
  if (pond.pellets.length < before) {
    pond.ripples.push({ x: nodes[0], y: nodes[1], born: time, strength: 0.6 });
    pond.bites.push({ x: nodes[0], y: nodes[1], born: time });
    k.nextSurface = time + rand(6, 16);
    // A mouthful whets it while food is about; each one also fills it up a little.
    k.rush = Math.min(1, k.rush + 0.2 * k.hunger);
    k.hunger = Math.max(0.45, k.hunger - 0.07);
  } else if (time > k.nextSurface) {
    // Now and then it mouths the surface on its own, without food.
    pond.ripples.push({ x: nodes[0], y: nodes[1], born: time, strength: 0.3 });
    k.nextSurface = time + (k.mood === "surface" ? rand(1.5, 4) : rand(8, 20));
  }
}

/**
 * A scare from (x, y): a C-start, an instant sprint here and a snap turn away in step(); it calms
 * over a couple of seconds. Close neighbours catch it, more mildly.
 */
function spook(pond, k, x, y) {
  const hx = k.nodes[0], hy = k.nodes[1], L = k.length;
  k.speed = Math.max(k.speed, (12 + L * 0.05) * 2.5);
  k.beat = 1;
  for (const o of pond.creatures) {
    if (o === k || o.species !== k.species || o.startle >= 0.5 || o.food || o.reactAt || Math.hypot(o.nodes[0] - hx, o.nodes[1] - hy) > L * 1.2) continue;
    o.startle = 0.75;
    o.fleeX = x;
    o.fleeY = y;
  }
  k.startle = 1;
  k.fleeX = x;
  k.fleeY = y;
}

/** A weighted draw over the idle moods, leaning on the koi's energy; never the one it is in. */
function pickMood(k) {
  let r = Math.random() * MOODS.reduce((sum, [name, w]) => sum + (name === k.mood ? 0 : w(k.energy)), 0);
  for (const [name, w] of MOODS) if (name !== k.mood && (r -= w(k.energy)) <= 0) return name;
  return "cruise";
}

function setMood(pond, k, name) {
  const [, , secs, speed] = MOODS.find((m) => m[0] === name);
  const time = pond.time;
  k.mood = name;
  k.moodUntil = time + rand(...secs) * (name === "search" ? 0.6 + 0.8 * k.curiosity : 1);
  k.vMood = rand(...speed);
  k.goalAt = 0;
  if (name === "rest") { k.depthTarget = 0.5; k.nextDive = k.moodUntil; }
  if (name === "surface") { k.depthTarget = k.depthMax; k.nextDive = k.moodUntil; k.nextSurface = time + rand(0.5, 2); }
  if (name === "follow") {
    let best = null, bestD = k.length * 3;
    for (const o of pond.creatures) {
      if (o.species !== k.species) continue;
      const d = Math.hypot(o.nodes[0] - k.nodes[0], o.nodes[1] - k.nodes[1]);
      if (o !== k && o.follow !== k && d < bestD) { best = o; bestD = d; }
    }
    if (!best) return setMood(pond, k, "cruise");
    k.follow = best;
  } else k.follow = null;
}

/** Where the current mood draws the koi, if anywhere. */
function moodGoal(pond, k) {
  const time = pond.time, L = k.length, hx = k.nodes[0], hy = k.nodes[1];
  if (k.mood === "follow") {
    const o = k.follow;
    if (!pond.creatures.includes(o) || Math.hypot(o.nodes[0] - hx, o.nodes[1] - hy) > L * 4) { setMood(pond, k, "cruise"); return null; }
    // Off to one side of its tail, not nose to tail.
    const t = (NODES - 1) * 2, side = hash3(k.id, o.id, 7) < 0.5 ? -0.35 : 0.35;
    return { x: o.nodes[t] - Math.sin(o.heading) * L * side, y: o.nodes[t + 1] + Math.cos(o.heading) * L * side };
  }
  if (k.mood === "search") {
    // Circles back to where the food was, nosing a new spot every couple of seconds.
    if (time > k.goalAt) {
      const a = rand(0, TAU), r = rand(0.2, 0.9) * L;
      k.goalX = k.foodX + Math.cos(a) * r; k.goalY = k.foodY + Math.sin(a) * r;
      k.goalAt = time + rand(1.5, 3);
    }
    return { x: k.goalX, y: k.goalY };
  }
  if (k.mood === "explore") {
    if (!k.goalAt) {
      // Somewhere well across the open water: not under the copy, not right where it is.
      const W = pond.width, H = pond.height;
      for (let i = 0; i < 8; i++) {
        k.goalX = rand(W * 0.12, W * 0.88); k.goalY = rand(H * 0.15, H * 0.85);
        if (Math.hypot(k.goalX - hx, k.goalY - hy) < Math.min(W, H) * 0.4) continue;
        if (!pond.avoid.some((b) => k.goalX > b.left && k.goalX < b.right && k.goalY > b.top && k.goalY < b.bottom)) break;
      }
      k.goalAt = time;
    }
    if (Math.hypot(k.goalX - hx, k.goalY - hy) < L * 0.5) { setMood(pond, k, pickMood(k)); return null; }
    return { x: k.goalX, y: k.goalY };
  }
  return null;
}

/**
 * Keep the current target while it lasts; only switch for a pellet less than half as far away, or
 * when a nearer koi has the same one in its sights and a free one is about. Without that, every
 * koi picked the same pellet out of a handful and they jammed over it while the rest sank.
 */
function pickFood(pond, k, x, y, range) {
  if (k.food && !pond.pellets.includes(k.food)) k.food = null;
  const nearest = nearestPellet(pond, k, x, y, range);
  if (!k.food) return (k.food = nearest);
  const current = Math.hypot(k.food.x - x, k.food.y - y);
  if (current > range * 1.3) k.food = nearest;
  else if (nearest && Math.hypot(nearest.x - x, nearest.y - y) < current * 0.5) k.food = nearest;
  else if (nearest && nearest !== k.food && claimed(pond, k, k.food, current * current) && !claimed(pond, k, nearest, (nearest.x - x) ** 2 + (nearest.y - y) ** 2)) k.food = nearest;
  return k.food;
}

/** Whether another koi of its kind, nearer than √d2, is already going for pellet `p`. */
function claimed(pond, k, p, d2) {
  return pond.creatures.some((o) => o !== k && o.species === k.species && o.food === p && (p.x - o.nodes[0]) ** 2 + (p.y - o.nodes[1]) ** 2 < d2);
}

/** The nearest landed pellet in range that no nearer koi has claimed; failing that, the nearest at all. */
function nearestPellet(pond, k, x, y, range) {
  let best = null, bestD = range * range, taken = null, takenD = range * range;
  for (const p of pond.pellets) {
    if (!p.landed) continue;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d >= bestD && d >= takenD) continue;
    if (claimed(pond, k, p, d)) { if (d < takenD) { takenD = d; taken = p; } }
    else if (d < bestD) { bestD = d; best = p; }
  }
  return best || taken;
}

// ─── drawing ────────────────────────────────────────────────────────────────
/**
 * Find the nearest point on the koi's render spine over the segments `from`..`to`
 * (inclusive), classify it against the outline, and leave the result in `hit`.
 */
function project(k, px, py, from = 0, to = NODES - 2) {
  const spine = k.spine;
  let best = Infinity, seg = from, u = 0, raw = 0, sx = 1, sy = 0;
  for (let n = from; n <= to; n++) {
    const ax = spine[n * 2], ay = spine[n * 2 + 1];
    const dx = spine[(n + 1) * 2] - ax, dy = spine[(n + 1) * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy || 1;
    const r = ((px - ax) * dx + (py - ay) * dy) / len2;
    const c = clamp(r, 0, 1);
    const qx = px - ax - dx * c, qy = py - ay - dy * c;
    const d2 = qx * qx + qy * qy;
    if (d2 < best) { best = d2; seg = n; u = c; raw = r; sx = dx; sy = dy; }
  }
  const len = Math.hypot(sx, sy) || 1;
  const dist = Math.sqrt(best);
  const L = k.length;
  const sign = sx * (py - spine[seg * 2 + 1]) - sy * (px - spine[seg * 2]) >= 0 ? 1 : -1;
  // How far past the tail tip / before the snout, and how far off the snout sideways.
  const past = seg === NODES - 2 && raw > 1 ? (raw - 1) * len : 0;
  const ahead = seg === 0 && raw < 0 ? -raw * len : 0;
  const lateral = Math.abs(sx * (py - spine[seg * 2 + 1]) - sy * (px - spine[seg * 2])) / len;

  hit.s = (k.arc[seg] + u * len) / k.arcTotal;
  hit.dist = dist;
  hit.v = dist * sign;
  hit.tx = sx / len;
  hit.ty = sy / len;
  hit.seg = seg;
  hit.inside = classify(hit.s, dist / L, past / L,
    sign > 0 ? fins.left : fins.right, hit, ahead / L, lateral / L);
  return hit.inside;
}

// ── one koi ───────────────────────────────────────────────────────────────
function draw(renderer, k, t) {
  const { cellW: cw, cellH: ch, cols, rows, grid, palette: P } = renderer;
  const L = k.length, nodes = k.nodes, spine = k.spine, arc = k.arc;

  // The body only undulates while the tail is beating; coasting koi hold almost straight.
  const swim = 0.2 + 1.1 * k.beat;
  for (let n = 0; n < NODES; n++) {
    const s = n / (NODES - 1);
    const a = Math.max(0, n - 1), b = Math.min(NODES - 1, n + 1);
    let tx = nodes[a * 2] - nodes[b * 2], ty = nodes[a * 2 + 1] - nodes[b * 2 + 1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    // Travelling body wave, growing toward the tail.
    const amp = L * 0.04 * (0.05 + 0.95 * Math.pow(s, 2.2)) * swim;
    const off = amp * Math.sin(k.phase - s * 4.6);
    spine[n * 2] = nodes[n * 2] - ty * off;
    spine[n * 2 + 1] = nodes[n * 2 + 1] + tx * off;
  }
  arc[0] = 0;
  for (let n = 1; n < NODES; n++) {
    arc[n] = arc[n - 1] +
      Math.hypot(spine[n * 2] - spine[(n - 1) * 2], spine[n * 2 + 1] - spine[(n - 1) * 2 + 1]);
  }
  k.arcTotal = arc[NODES - 1] || 1;

  // Pectorals tuck in during a burst, scull while coasting, and the inner one
  // spreads to brake on a turn.
  const spread = 1 - 0.25 * k.beat;
  const scull = 0.18 * (1 - k.beat) * Math.sin(k.finPhase);
  const bank = clamp(k.turn * 0.6, -0.35, 0.35);
  k.flareLeft = spread + scull - bank;
  k.flareRight = spread - scull + bank;
  fins.left = finProfile(k.flareLeft);
  fins.right = finProfile(k.flareRight);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let n = 0; n < NODES; n++) {
    minX = Math.min(minX, spine[n * 2]); maxX = Math.max(maxX, spine[n * 2]);
    minY = Math.min(minY, spine[n * 2 + 1]); maxY = Math.max(maxY, spine[n * 2 + 1]);
  }
  const reach = L * 0.26;
  const c0 = Math.max(0, Math.floor((minX - reach) / cw));
  const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
  const r0 = Math.max(0, Math.floor((minY - reach) / ch));
  const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
  if (c0 > c1 || r0 > r1) return;

  const diag = Math.hypot(cw, ch);
  // Near the surface a koi is brighter and its shadow falls farther away.
  const shadowDc = Math.round((L * 0.07 * k.depth) / cw) + 1;
  const shadowDr = Math.round((L * 0.05 * k.depth) / ch) + 1;
  const dim = P.alpha * (P.depthFloor + (1 - P.depthFloor) * k.depth);
  const [tileLo, tileHi] = P.tile;

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = c * cw, y = r * ch;
      const centerHit = project(k, x + cw / 2, y + ch / 2);
      const centerDist = hit.dist, centerSeg = hit.seg;
      // Nothing reaches far from the spine at the waist, where the fins end.
      const reachFromSpine = L * (hit.s > 0.4 && hit.s < 0.62 ? 0.15 : 0.25) + diag;
      if (!centerHit && centerDist > reachFromSpine) {
        // Distance to the spine changes by at most a cell per cell: skip ahead.
        c += Math.max(0, Math.floor((centerDist - L * 0.25 - diag) / cw));
        continue;
      }

      // Sub-samples sit within a cell of the centre, so only the neighbouring segments can be nearest.
      const from = Math.max(0, centerSeg - 2), to = Math.min(NODES - 2, centerSeg + 2);
      let flag = hit.flag, across = hit.across, s = hit.s, v = hit.v, tx = hit.tx, ty = hit.ty;
      const dist = centerDist;

      let hits = centerHit ? 1 : 0;
      // Points from the cell centre toward the covered side, i.e. across the outline into the koi.
      let gx = 0, gy = 0;
      // Cells well inside the body can't have a sub-sample outside it: full coverage.
      const deepInside = centerHit && flag !== F_FIN && flag !== F_BARBEL &&
        s > 0.04 && s < 0.72 && halfWidth(s) * L - dist > diag * 0.35;
      if (deepInside) hits = 5;

      for (let q = 0; !deepInside && q < SUBSAMPLES.length; q += 2) {
        if (!project(k, x + SUBSAMPLES[q] * cw, y + SUBSAMPLES[q + 1] * ch, from, to)) continue;
        gx += (SUBSAMPLES[q] - 0.5) * cw;
        gy += (SUBSAMPLES[q + 1] - 0.5) * ch;
        if (hits === 0) {
          flag = hit.flag; across = hit.across; s = hit.s; v = hit.v; tx = hit.tx; ty = hit.ty;
        }
        hits++;
      }
      if (hits === 0) continue;

      const coverage = hits / 5;
      const side = v >= 0 ? 1 : -1;
      const i = r * cols + c;
      // Body-anchored key, so each glyph rides along with the skin. Bins are about a cell long:
      // finer ones made every cell flip glyphs several times while crossing it, a constant boil.
      const key = (hash3(Math.round((s * L) / cw), Math.round(v / (cw * 0.8)), k.id) * 4294967295) >>> 0;
      const solid = centerHit && coverage >= 0.6;

      let glyph = " ", rgb = P.fin, alpha = dim, tile = null, tileAlpha = 0;
      if (flag === F_BARBEL) {
        // Drawn along the whisker: forward from the mouth, angled out to its side.
        glyph = lineGlyph(-tx - side * ty * 0.7, -ty + side * tx * 0.7);
        rgb = shade(mix(P.bg, P.fin, 0.9), P.ink + 0.3);
      } else if (flag === F_EYE && solid) {
        tile = mix(P.bg, P.eye, 0.85);
        tileAlpha = dim;
        glyph = "o";
        rgb = mix(P.bg, P.white, 0.9);
      } else if (flag === F_FIN) {
        // Fins are a pale veil of tiles flecked with dots, so they never compete with the body.
        tile = mix(P.bg, P.fin, 0.55);
        tileAlpha = dim * 0.45 * coverage;
        if (key % 2 === 0) {
          glyph = ".";
          alpha *= 0.6 * coverage;
        }
      } else {
        // Each skin cell is a tile washed in the skin colour, shaded like a rounded
        // back lit from the top-left, with a dense glyph etched on top.
        const skinColor = skin(P, k, s, v, across);
        const facing = side * (0.6 * ty - 0.8 * tx) * across;
        const lum = clamp(0.22 + 0.5 * Math.sqrt(1 - across * across) + 0.18 * facing, 0, 1);
        if (skinColor === P.red) {
          // Red patches run the full hi ramp: crimson in shadow, vermilion across
          // the back, amber where the light hits. Each koi leans redder or more
          // orange, a body-pinned noise varies the hue, and a band of shine slides
          // down the body like light over wet scales.
          const lean = (hash3(k.id, 5, 17) - 0.5) * 0.3;
          const grain = (valueNoise(s * 9 + k.id, (v / L) * 18, k.id + 21) - 0.5) * 0.25;
          const sheen = Math.max(0, Math.sin(s * 11 - t * 1.8 + k.id) - 0.7) / 0.3;
          tile = ramp(P.hi, 0.15 + 0.8 * lum + lean + grain + sheen * 0.35);
        } else {
          tile = mix(P.bg, skinColor, tileLo + (tileHi - tileLo) * lum);
        }
        if (hits === 5) {
          const sc = c + shadowDc, sr = r + shadowDr;
          if (sc < cols && sr < rows) grid.shadow[sr * cols + sc] = 1;
          tileAlpha = dim;
          if (s < 0.035 && across < 0.6 && k.gulp > 0.5) {
            glyph = "o";
            rgb = P.eye;
          } else {
            const jitter = (key >>> 4) % 3;
            glyph = TILE_GLYPHS[clamp(Math.round((1 - lum) * 4) + jitter, 0, TILE_GLYPHS.length - 1)];
            rgb = shade(tile, P.ink);
            // White skin is etched lightly so the red and black patches carry the pattern.
            if (skinColor === P.white) alpha *= 0.6;
            // Scales glint on a staggered clock.
            const tick = Math.floor(t * 1.4 + (key % 997) / 97);
            if (hash3(key, tick, 7) < 0.03) tile = mix(tile, P.bg, 0.45);
          }
        } else {
          tileAlpha = dim * coverage * 0.55;
          if (Math.hypot(gx, gy) > cw * 0.2 && key % 3 === 0) {
            glyph = ".";
            rgb = shade(tile, P.ink);
          }
        }
      }
      if (glyph === " " && tileAlpha === 0) continue;
      // A faint fringe or fin veil never punches a hole in a koi already drawn beneath it.
      if (grid.glyph[i] && grid.tileAlpha[i] > tileAlpha) continue;
      grid.tile[i] = tile ? packRgb(tile) : 0;
      grid.tileAlpha[i] = tileAlpha;
      grid.glyph[i] = glyph.charCodeAt(0);
      grid.color[i] = packRgb(rgb);
      grid.alpha[i] = alpha;
    }
  }
}

/** A koi's markings, computed once: they are a property of its id and variety, not its pose. */
function markings(k) {
  if (k.marked !== k.variety) { k.markings = koiMarkings(k); k.marked = k.variety; }
  return k.markings;
}

/** Skin colour for a body point, from the koi's own markings pinned to body coordinates. */
function skin(P, k, s, v, across) {
  const vn = v / k.length;
  // Belly edges and the tail stalk stay white on every variety, framing the markings.
  if (across > 0.9 || s > BODY_END) return P.white;
  // Ragged edges, so patches read as painted markings rather than ellipses.
  const wobble = (valueNoise(s * 14 + k.id, vn * 30, k.id + 3) - 0.5) * 0.6;
  const marks = markings(k);
  for (const m of marks.black) if (inPatch(m, s, vn, wobble)) return P.black;
  for (const m of marks.red) if (inPatch(m, s, vn, wobble)) return P.red;
  return P.white;
}

/** Scratch: steering push from content, the fins of the koi being drawn, the last spine projection. */
const PUSH = { x: 0, y: 0 };
const fins = { left: finProfile(1), right: finProfile(1) };
const hit = { flag: 0, across: 1, s: 0, v: 0, dist: 0, tx: 1, ty: 0, seg: 0, inside: false };

/** The tail stirs the water behind it, more the faster it swims. */
function wake(r, k) {
  for (let n = NODES - 4; n < NODES; n++) r.stir(k.nodes[n * 2], k.nodes[n * 2 + 1], 0.035 + k.speed * 0.0012);
}

/**
 * The koi species. `count` adults ("auto": 3–6 by pond area), `young` small ones that keep to the
 * deep ("auto": two on wide screens), recounted when the window settles at a new size (adding up
 * to `max`).
 */
export function koi(config = {}) {
  const species = {
    name: "koi",
    colors: COLORS,
    seed: (pond) => seed(pond, species, config),
    grow: (pond) => grow(pond, species, config),
    splash: (pond, p) => splash(pond, species, p),
    floating: (pond, p) => floating(pond, species, p),
    step,
    draw,
    wake,
  };
  return species;
}
