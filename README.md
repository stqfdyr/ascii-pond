# ascii-pond

简体中文 | [English](README.en.md)

用等宽字符方块画出的鱼在你的页面背后游动。它们会慢慢游向光标，点击水面就会浮上来吃食。
不需要构建，没有依赖。

演示：<https://ascii.3301921.xyz/>

有两种用法：

- **嵌入**：一个元素（或一次函数调用）就能给任何页面或博客加上池塘，可以铺满整个页面背后，也可以放在一个框里。
- **模板**：`index.html` 是一个基于嵌入方式的单页小站（导航、三个视图、深色/纸色主题，切换时带擦除动画）。
  fork 之后改掉 `<title>` 和文案即可。

## 运行

```sh
python3 -m http.server 8899
# http://127.0.0.1:8899/index.html           模板
# http://127.0.0.1:8899/examples/embed.html  博客文章头图里的池塘
```

必须通过 http 打开，不能用 `file://`：代码是 ES 模块，网页字体也无法从本地磁盘加载。

## 嵌入

```html
<script type="module" src="/path/to/src/pond.js"></script>

<!-- 铺在整个页面背后 -->
<ascii-pond fixed></ascii-pond>

<!-- 或放在一个框里：元素会填满自身，所以要给它尺寸 -->
<ascii-pond style="height: 320px"></ascii-pond>
```

| 属性 | |
|---|---|
| `species` | 逗号分隔的物种名，默认 `koi` |
| `count`、`young` | 每个物种的成鱼数和幼鱼数（默认按池塘大小决定） |
| `theme` | `auto`（跟随系统并实时切换）、`dark` 或 `light` |
| `avoid` | 鱼会绕开、并在其下方淡出的内容的 CSS 选择器，默认 `[data-pond-avoid]` |
| `fixed` | 铺满整个视口作背景，而不是填满元素 |
| `no-feed` | 点击不投喂 |

在脚本里调用：

```js
import { mount } from "./src/pond.js";

const pond = mount(document.body, {
  species: [{ type: "koi", count: 4, young: 1 }],
  theme: "auto",
  palette: { dark: { page: [16, 16, 20] } },   // 与你的页面背景一致
});
pond.feed(200, 150);                 // 在画布坐标处投食
pond.setTheme(true, { x, y });       // 切到浅色，从 (x, y) 向外擦除
pond.destroy();
```

`mount(target, options)` 接受一个用来绘制的 `<canvas>`，或任意元素（会在里面放一个 canvas）。挂在 `<body>` 上时
是固定背景。返回 `{ pond, renderer, canvas, feed, setTheme, measure, destroy }`。

| 选项 | 默认值 | |
|---|---|---|
| `species` | `["koi"]` | 物种名、`{ type, ...config }` 或物种对象 |
| `theme` | `"auto"` | `"auto"`、`"dark"`、`"light"`；调用 `setTheme()` 后不再跟随 `auto` |
| `avoid` | `"[data-pond-avoid]"` | 要绕开并在其下方变暗的内容；`null` 表示没有 |
| `ignore` | 链接、按钮、输入框、`[data-pond-ignore]` | 点击这些永远不投喂 |
| `feed` | `true` | 点击水面投食 |
| `fixed` | 挂在 `<body>` 上时 | 铺满整个视口作背景 |
| `speed` | `1` | 模拟速度；开启减弱动态效果时乘以 0.2 |
| `palette` | `{}` | 按主题覆盖配色，例如 `{ dark: { page, bg, water, pellet, … } }`（见 `src/pond.js` 里的 `DARK`） |
| `onFrame` | | 每帧结束后以实例为参数调用 |

给内容加上标记，鱼就会把它当障碍物，而不是水面：

```html
<article data-pond-avoid>…</article>   <!-- 鱼会绕开它，并在它的文字下方淡出 -->
<div data-pond-ignore>…</div>          <!-- 点这里永远不投喂 -->
```

画布是透明的，方块颜色会向配色里的 `bg` 混合，所以 `page` 和 `bg` 要设得接近页面的背景色。

## 物种

每种生物是一个模块。`src/koi.js` 是第一个：身体轮廓、花纹（红白、大正三色、丹顶）、行为和绘制。
物种是一个对象：

```js
{
  name: "jellyfish",
  colors: { dark: { … }, light: { … } },   // 它绘制时额外用到的配色键
  seed(pond) {},                            // 把最初的个体放进 pond.creatures
  grow(pond, areaBefore) {},                // 可选：窗口变大时补充个体
  step(pond, creature, dt) {},              // 让一个个体前进一步（1/120 秒）
  draw(renderer, creature, time) {},        // 把它的格子写进 renderer.grid
  wake(renderer, creature) {},              // 可选：renderer.stir(x, y, amount)
  splash(pond, pellet) {},                  // 可选：一粒饵料刚落水
  floating(pond, pellet) {},                // 可选：饵料漂浮时每一步调用
}
```

每个个体都需要 `species`（上面的对象）和 `depth`，从 0（深处）到 1（水面）。越深的越先画。
用 `SPECIES.jellyfish = (config) => ({ … })` 注册物种，或者直接把对象传给 `species`。

## 原理

- 固定 120 Hz 的模拟，所以在 60、120、144 Hz 下动作完全一样。水波也按模拟时间运行。
- 一条锦鲤是一根跟随头部的 20 节脊柱。屏幕上每个格子都投影到脊柱上，判定为身体、鳍、眼睛或须，
  再画成一个刻有字符的方块。花纹固定在身体坐标上，所以图案随皮肤一起移动。
- 行为是分层的。每条锦鲤有自己的性情，在几种状态之间切换（巡游、滑行、探索、休息、上浮、跟随），
  每种持续随机时长，偶尔冲刺一下。速度来自尾部推力与阻力的平衡，转向的缓急与偏离航向的程度成正比。
  每条锦鲤出场时饥饿程度各不相同：饿的会冲向食物、互相争抢，饱的慢悠悠游过去或干脆不理；
  每吃一口胃口都会被吊起一点，然后各自慢慢平静下来。
- 偶尔会有一条锦鲤无缘无故受惊、猛地窜开（C 形启动），附近的同伴也跟着一抖。手指拖过会留下水波。
  开启减弱动态效果时以 0.2 倍速运行，投喂照常可用。强制颜色模式下隐藏池塘。

## 文件

| | |
|---|---|
| `src/pond.js` | 引擎：池塘、水面、渲染器、主题擦除、`mount()`、`<ascii-pond>` |
| `src/koi.js` | 锦鲤物种 |
| `src/util.js` | 共用数学函数 |
| `index.html` | 单页模板 |
| `examples/embed.html` | 嵌入页面的示例 |
| `fonts/` | Geist Mono（SIL OFL 1.1，见 `fonts/GEIST-LICENSE`），模板使用 |

需要较新的浏览器：ES 模块、自定义元素、`ResizeObserver`、CSS `color-mix()`（模板用到）。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。附带的字体 Geist Mono 采用 SIL Open Font License 1.1（[`fonts/GEIST-LICENSE`](fonts/GEIST-LICENSE)）。
