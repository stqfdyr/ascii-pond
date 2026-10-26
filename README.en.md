# ascii-pond

[简体中文](README.md) | English

Fish drawn as monospace glyph tiles swim behind your page. They drift over to the cursor and
come up to eat when you click the water. No build step, no dependencies.

Demo: <https://ascii.3301921.xyz/>

There are two ways to use it:

- **As an embed**: one element (or one function call) adds a pond to any page or blog, behind
  everything or in a box.
- **As a template**: `index.html` is a small one-page site (nav, three views, dark/paper theme
  with a live wipe) built on the embed. Fork it, change the `<title>` and the copy.

## Run it

```sh
python3 -m http.server 8899
# http://127.0.0.1:8899/index.html           the template
# http://127.0.0.1:8899/examples/embed.html  a pond in a blog post's header
```

It needs http, not `file://`: it is ES modules, and the web font won't load from disk.

## Embed

```html
<script type="module" src="/path/to/src/pond.js"></script>

<!-- behind the whole page -->
<ascii-pond fixed></ascii-pond>

<!-- or in a box: the element fills itself, so give it a size -->
<ascii-pond style="height: 320px"></ascii-pond>
```

| Attribute | |
|---|---|
| `species` | comma-separated species names, default `koi` |
| `count`, `young` | how many adults and young of each species (default: by pond size) |
| `theme` | `auto` (follow the OS, live), `dark` or `light` |
| `avoid` | CSS selector of content the fish swim around and fade under, default `[data-pond-avoid]` |
| `fixed` | full-viewport background instead of filling the element |
| `no-feed` | clicks don't throw food |

From a script:

```js
import { mount } from "./src/pond.js";

const pond = mount(document.body, {
  species: [{ type: "koi", count: 4, young: 1 }],
  theme: "auto",
  palette: { dark: { page: [16, 16, 20] } },   // match your page background
});
pond.feed(200, 150);                 // throw food at canvas coordinates
pond.setTheme(true, { x, y });       // to light, wiping out from (x, y)
pond.destroy();
```

`mount(target, options)` takes a `<canvas>` to draw into, or any element to put one in. Mounted
on `<body>` it is a fixed background. It returns `{ pond, renderer, canvas, feed, setTheme, measure, destroy }`.

| Option | Default | |
|---|---|---|
| `species` | `["koi"]` | names, `{ type, ...config }`, or species objects |
| `theme` | `"auto"` | `"auto"`, `"dark"`, `"light"`; `setTheme()` takes over from `auto` |
| `avoid` | `"[data-pond-avoid]"` | content to steer around and dim under; `null` for none |
| `ignore` | links, buttons, inputs, `[data-pond-ignore]` | clicks on these never feed |
| `feed` | `true` | click the water to throw food |
| `fixed` | on `<body>` | full-viewport background |
| `speed` | `1` | simulation speed; reduced motion multiplies it by 0.2 |
| `palette` | `{}` | overrides per theme, e.g. `{ dark: { page, bg, water, pellet, … } }` (see `DARK` in `src/pond.js`) |
| `onFrame` | | called after each frame with the instance |

Mark your content so the fish treat it as an obstacle, not as water:

```html
<article data-pond-avoid>…</article>   <!-- fish swim around it and fade beneath its text -->
<div data-pond-ignore>…</div>          <!-- clicks here never feed -->
```

The canvas is transparent and the tiles are mixed toward the palette's `bg`, so set `page` and
`bg` close to your page's background colour.

## Species

Each kind of creature is a module. `src/koi.js` is the first: body outline, markings
(kohaku, sanke, tancho), behaviour and drawing. A species is an object:

```js
{
  name: "jellyfish",
  colors: { dark: { … }, light: { … } },   // extra palette keys it draws with
  seed(pond) {},                            // push its first creatures into pond.creatures
  grow(pond, areaBefore) {},                // optional: more when the window grows
  step(pond, creature, dt) {},              // move one creature one 1/120 s step
  draw(renderer, creature, time) {},        // write its cells into renderer.grid
  wake(renderer, creature) {},              // optional: renderer.stir(x, y, amount)
  splash(pond, pellet) {},                  // optional: a pellet just landed
  floating(pond, pellet) {},                // optional: each step a pellet floats
}
```

Every creature needs `species` (the object above) and a `depth` from 0 (deep) to 1 (surface).
Deeper ones are drawn first. Register a species with `SPECIES.jellyfish = (config) => ({ … })`,
or pass the object straight in `species`.

## How it works

- A fixed 120 Hz simulation, so motion is the same at 60, 120 or 144 Hz. The wake also runs on sim time.
- A koi is a 20-node spine that follows its head. Each screen cell is projected onto the spine
  and classified as body, fin, eye or barbel, then drawn as a tile with a glyph etched on it.
  Markings are pinned to body coordinates, so the pattern rides with the skin.
- Behaviour is layered. Each koi has its own temperament. It moves between moods (cruise,
  glide, explore, rest, surface, follow), each lasting a random time, with the odd dash. Speed comes
  from tail thrust against drag, and turns ease in proportion to how far off course it is.
  Each koi arrives with its own hunger: the hungry bolt for food and race each other, the full
  amble over or sit it out, every mouthful whets it a little more, and each winds down on its own.
- Now and then a koi takes fright at nothing in particular and bolts (a C-start), and close
  neighbours flinch with it. A finger drag leaves a wake. Reduced motion runs at 0.2× and feeding
  still works. Forced-colours mode hides the pond.

## Files

| | |
|---|---|
| `src/pond.js` | engine: pond, water, renderer, theme wipe, `mount()`, `<ascii-pond>` |
| `src/koi.js` | the koi species |
| `src/util.js` | shared math |
| `index.html` | the one-page template |
| `examples/embed.html` | embedding in a page |
| `fonts/` | Geist Mono (SIL OFL 1.1, `fonts/GEIST-LICENSE`), used by the template |

Needs a current browser: ES modules, custom elements, `ResizeObserver`, CSS `color-mix()` (the template).

## License

MIT, see [`LICENSE`](LICENSE). The bundled font, Geist Mono, is under the SIL Open Font License 1.1 ([`fonts/GEIST-LICENSE`](fonts/GEIST-LICENSE)).
