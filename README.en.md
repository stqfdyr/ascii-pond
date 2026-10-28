# ascii-pond

[简体中文](README.md) | English

Koi made of text characters swim behind your web page. Move the mouse and they come over;
click the water to drop food. Plain JavaScript: no build step, no dependencies.

Demo: <https://ascii.3301921.xyz/>

![The pond: dropping food, then switching to the light theme](demo.webp)

## Quick start

Add two lines to your page:

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/stqfdyr/ascii-pond@main/src/pond.js"></script>
<ascii-pond fixed></ascii-pond>
```

Now there's a pond behind the whole page. For a pond in one spot (say, a post header), drop
`fixed` and give it a height:

```html
<ascii-pond style="height: 320px"></ascii-pond>
```

Add `data-pond-avoid` to your content and the fish swim around it, fading out under the text so
it stays readable:

```html
<article data-pond-avoid>…</article>
```

To avoid the CDN, copy `src/` into your site and point `src` at it.

## Use the template

`index.html` is a ready-made one-page site: top nav, three pages, dark/light switch. Fork the
repo, change the title and the text, done.

Preview it over http (ES modules don't load from a double-clicked file):

```sh
python3 -m http.server 8899
# template:      http://127.0.0.1:8899/
# embed example: http://127.0.0.1:8899/examples/embed.html
```

## Options

### Attributes

| Attribute | What it does |
|---|---|
| `fixed` | fill the window, as the page background |
| `theme` | `auto` (follow the system, default), `dark`, `light` |
| `count`, `young` | how many big and small fish; default depends on pond size |
| `species` | which creatures, comma-separated; default `koi` |
| `avoid` | CSS selector for elements the fish swim around; default `[data-pond-avoid]` |
| `no-feed` | clicks don't drop food |
| `keep` | a name: when the element leaves the page its pond is held, and the next element with the same name carries on with the same fish. For client-side routing (Astro, Turbo…); a full reload still starts over |

### From JavaScript

```js
import { mount } from "./src/pond.js";

const pond = mount(document.body, {
  theme: "auto",
  species: [{ type: "koi", count: 4, young: 1 }],
  palette: { dark: { page: [16, 16, 20] } },  // set to your page background
});

pond.feed(200, 150);            // drop food at (200, 150)
pond.setTheme(true, { x, y });  // switch to light, spreading out from (x, y)
pond.destroy();                 // remove the pond
```

`mount` takes a `<canvas>` or any element (it adds a canvas inside). Pass `document.body` and it
fills the page. It returns `{ pond, renderer, canvas, feed, setTheme, measure, destroy }`.

| Option | Default | What it does |
|---|---|---|
| `species` | `["koi"]` | as the attribute; also `{ type, count, young }` or a species object |
| `theme` | `"auto"` | as the attribute; after `setTheme()` it stops following the system |
| `avoid` | `"[data-pond-avoid]"` | as the attribute; `null` turns it off |
| `ignore` | links, buttons, inputs, `[data-pond-ignore]` | clicks here don't drop food |
| `feed` | `true` | click to drop food |
| `fixed` | on when mounted on `<body>` | fill the window |
| `speed` | `1` | swim speed; drops to 0.2× when the system asks for reduced motion |
| `palette` | `{}` | colour overrides; see `DARK` in `src/pond.js` for the keys |
| `onFrame` | | called after each frame |
| `pond` | | the `pond` from an earlier `mount` to carry on with, instead of new fish |

The canvas is transparent and the tiles are blended toward `bg`, so set `page` and `bg` in
`palette` close to your page background, or the pond won't match the page.

## Add a creature

Koi are the first species (`src/koi.js`). A species is an object with these functions:

```js
{
  name: "jellyfish",
  colors: { dark: { … }, light: { … } },  // extra colours it uses
  seed(pond) {},                           // create the first ones, push into pond.creatures
  step(pond, creature, dt) {},             // update one creature (120 times a second)
  draw(renderer, creature, time) {},       // draw it into renderer.grid
  grow(pond) {},                           // optional: once a resize holds still 1.5 s, add or remove to suit
  wake(renderer, creature) {},             // optional: stir the water, renderer.stir(x, y, amount)
  splash(pond, pellet) {},                 // optional: food just hit the water
  floating(pond, pellet) {},               // optional: called on every update while food floats
}
```

Each creature needs `species` (this object) and `depth` (0 = bottom, 1 = surface; deeper ones
are drawn first); set `gone = true` on one to remove it after the step. Register it with `SPECIES.jellyfish = (config) => ({ … })`, or pass it straight
to the `species` option.

## How it works

- The simulation always runs 120 steps a second, so motion looks the same on 60 Hz and 144 Hz screens.
- Each koi is a 20-segment spine that follows its head. Every screen cell is checked against it
  (body, fin, eye or barbel) and drawn as a tile with a character on it. Markings stick to the
  body, so they bend with the fish.
- Each fish has its own temperament and switches between cruising, gliding, exploring, resting,
  rising and following another fish, with the odd sudden dash. Hungry fish fight over food;
  full ones can't be bothered.
- Now and then a fish startles at nothing and darts off, and its neighbours flinch. Dragging a
  finger across the water leaves ripples.
- With reduced motion on, the fish swim slower and feeding still works. In forced-colours (high
  contrast) mode the pond is hidden.

## Files

| File | Contents |
|---|---|
| `src/pond.js` | engine: pond, water, rendering, theme switch, `mount()`, `<ascii-pond>` |
| `src/koi.js` | koi |
| `src/util.js` | shared maths |
| `index.html` | one-page template |
| `favicon.svg` | the template's tab icon |
| `demo.webp` | the demo animation in this README |
| `examples/embed.html` | embed example |
| `fonts/` | Geist Mono, used by the template |

Needs ES modules, custom elements and `ResizeObserver`; the template also uses CSS `color-mix()`.
Any mainstream browser from the last few years works.

## Thanks

Thanks to [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) for the inspiration.

## License

MIT, see [`LICENSE`](LICENSE). The bundled Geist Mono font is under the SIL OFL 1.1, see [`fonts/GEIST-LICENSE`](fonts/GEIST-LICENSE).
