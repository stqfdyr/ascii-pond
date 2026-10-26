# ascii-pond

简体中文 | [English](README.en.md)

用字符拼成的锦鲤在网页背后游来游去。鼠标移过去，鱼会游过来；点一下水面就撒鱼食。
纯 JavaScript，不用构建，没有依赖。

在线演示：<https://ascii.3301921.xyz/>

![池塘演示：撒鱼食，再切到浅色主题](demo.webp)

## 快速上手

在页面里加两行：

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/stqfdyr/ascii-pond@main/src/pond.js"></script>
<ascii-pond fixed></ascii-pond>
```

整个页面背后就有了池塘。只想放在某一块（比如文章头图），去掉 `fixed`，给它一个高度：

```html
<ascii-pond style="height: 320px"></ascii-pond>
```

给正文加上 `data-pond-avoid`，鱼就会绕着它游，游到文字底下时自动变淡，不挡阅读：

```html
<article data-pond-avoid>…</article>
```

不想依赖 CDN，就把 `src/` 目录复制到自己的站点，`src` 改成对应的路径。

## 用模板建站

`index.html` 是一个现成的单页小站：顶部导航、三个页面、深浅色切换。Fork 本仓库，改掉标题和文字就能用。

本地预览要用 http 打开（ES 模块不支持直接双击打开文件）：

```sh
python3 -m http.server 8899
# 模板：     http://127.0.0.1:8899/
# 嵌入示例： http://127.0.0.1:8899/examples/embed.html
```

## 配置

### 标签属性

| 属性 | 作用 |
|---|---|
| `fixed` | 铺满整个窗口，作为页面背景 |
| `theme` | `auto`（跟随系统，默认）、`dark`、`light` |
| `count`、`young` | 大鱼、小鱼各几条，默认按池塘大小定 |
| `species` | 放哪些生物，逗号分隔，默认 `koi` |
| `avoid` | 鱼要绕开的元素（CSS 选择器），默认 `[data-pond-avoid]` |
| `no-feed` | 点击不撒鱼食 |

### 用 JavaScript 控制

```js
import { mount } from "./src/pond.js";

const pond = mount(document.body, {
  theme: "auto",
  species: [{ type: "koi", count: 4, young: 1 }],
  palette: { dark: { page: [16, 16, 20] } },  // 改成你的页面背景色
});

pond.feed(200, 150);            // 在 (200, 150) 撒鱼食
pond.setTheme(true, { x, y });  // 切到浅色，从 (x, y) 处向外铺开
pond.destroy();                 // 移除池塘
```

`mount` 的第一个参数可以是 `<canvas>`，也可以是任意元素（会在里面建一个 canvas）；
传 `document.body` 时自动铺满整页。返回 `{ pond, renderer, canvas, feed, setTheme, measure, destroy }`。

| 选项 | 默认 | 作用 |
|---|---|---|
| `species` | `["koi"]` | 同标签属性；也可以写 `{ type, count, young }`，或直接传物种对象 |
| `theme` | `"auto"` | 同标签属性；调用过 `setTheme()` 后不再跟随系统 |
| `avoid` | `"[data-pond-avoid]"` | 同标签属性；传 `null` 关闭 |
| `ignore` | 链接、按钮、输入框、`[data-pond-ignore]` | 点这些地方不撒鱼食 |
| `feed` | `true` | 点击撒鱼食 |
| `fixed` | 挂在 `<body>` 上时开启 | 铺满整个窗口 |
| `speed` | `1` | 游动速度；系统开了「减弱动态效果」时自动降到 0.2 倍 |
| `palette` | `{}` | 改配色，可用的键见 `src/pond.js` 里的 `DARK` |
| `onFrame` | | 每帧画完后调用 |

画布是透明的，字符方块的颜色会往 `bg` 上混，所以 `palette` 里的 `page` 和 `bg` 要设成接近页面背景的颜色，
不然池塘和页面会有色差。

## 加新的生物

锦鲤是第一个物种（`src/koi.js`）。每种生物是一个对象，实现下面这些函数：

```js
{
  name: "jellyfish",
  colors: { dark: { … }, light: { … } },  // 它额外用到的颜色
  seed(pond) {},                           // 生成初始个体，放进 pond.creatures
  step(pond, creature, dt) {},             // 更新一个个体（每秒 120 次）
  draw(renderer, creature, time) {},       // 把它画进 renderer.grid
  grow(pond, areaBefore) {},               // 可选：窗口变大时补几条
  wake(renderer, creature) {},             // 可选：搅出水波，用 renderer.stir(x, y, amount)
  splash(pond, pellet) {},                 // 可选：鱼食刚落水
  floating(pond, pellet) {},               // 可选：鱼食漂在水面时，每次更新都调用
}
```

每个个体要带上 `species`（指向这个对象）和 `depth`（0 是水底，1 是水面，越深越先画）。
写好后用 `SPECIES.jellyfish = (config) => ({ … })` 注册，或者直接传给 `species` 选项。

## 实现原理

- 模拟固定每秒算 120 次，60 Hz 和 144 Hz 的屏幕上看到的动作一样。
- 每条锦鲤是一根 20 节的「脊椎」，跟着头走。屏幕上每个格子先判断落在身体、鳍、眼睛还是须上，
  再画成一个带字符的方块。花纹贴在身体上，鱼一弯，花纹跟着弯。
- 每条鱼性格不同，在巡游、滑行、探索、休息、上浮、跟着别的鱼之间随机切换，偶尔突然冲一下。
  饿的鱼会抢食，吃饱的爱理不理。
- 偶尔有鱼无缘无故受惊窜开，旁边的鱼跟着一抖。手指划过水面会留下水波。
- 系统开了「减弱动态效果」时鱼游得更慢，撒鱼食照常；高对比度（强制颜色）模式下不显示池塘。

## 文件

| 文件 | 内容 |
|---|---|
| `src/pond.js` | 引擎：池塘、水面、渲染、主题切换、`mount()`、`<ascii-pond>` |
| `src/koi.js` | 锦鲤 |
| `src/util.js` | 公用的数学函数 |
| `index.html` | 单页模板 |
| `favicon.svg` | 模板的网页图标 |
| `demo.webp` | README 里的演示动图 |
| `examples/embed.html` | 嵌入示例 |
| `fonts/` | 模板用的 Geist Mono 字体 |

浏览器要支持 ES 模块、自定义元素和 `ResizeObserver`，模板还用到 CSS `color-mix()`。近几年的主流浏览器都没问题。

## 致谢

感谢 [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) 带来的灵感。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。附带的 Geist Mono 字体是 SIL OFL 1.1 许可，见 [`fonts/GEIST-LICENSE`](fonts/GEIST-LICENSE)。
