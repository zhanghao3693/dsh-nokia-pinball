# dsh-nokia-pinball · 诺基亚弹珠台

一款跑在 DeepSeek Harness Web GUI 右下角的复古弹珠台（Pinball）小游戏，
复刻 2007–2009 年诺基亚 J2ME 手机上那种竖屏、像素台面、方波蜂鸣的手感。

点右下角「弹珠台」悬浮按钮展开面板，再点一次收起。面板跨路由常驻。

## 玩法

竖屏 360×640 像素台面，钢珠受重力下落，靠左右两片弹片（flipper）把球打回台面得分。

- **发射**：按住「发射」按钮或空格蓄力，松手弹出。蓄力越久初速越大；
  轻点一下球会弹回发射槽、可重新蓄力，不判失球。
- **弹片**：`←` / `A` 控左，`→` / `D` 控右；也可用面板底部三个屏幕按钮（左 / 发射 / 右）。
- **计分**：缓冲器 100 分 × 连击倍率；靶子 250 分，5 个全亮额外 +2000 并重置；
  滚道 150 分，3 个全亮额外 +1000 并重置。每连续 3 次命中倍率 +1，上限 5 倍。
- **失球**：球从底部漏下掉一颗，3 球用尽即 GAME OVER，显示本局得分与历史最高。
- **高分**：存浏览器 localStorage（`dsh.nokia-pinball.hi.v1`），刷新不丢。
- **音效**：WebAudio 方波模拟诺基亚蜂鸣，右下角 ♪ 可开关；`R` 重开一局。

## 操作

| 输入 | 作用 |
| --- | --- |
| `←` / `A` | 左弹片 |
| `→` / `D` | 右弹片 |
| `空格`（按住蓄力，松开弹） | 发射钢珠 |
| `R` | 重开一局 |
| 屏幕按钮 左 / 发射 / 右 | 触屏或鼠标等效操作 |

在输入框里打字时键盘监听会自动让位，不会抢焦点。

## 安装

这是一个 DSH 客户端 bundle：Host 入口是空壳，全部逻辑跑在浏览器侧 `client.js`，
注册到 `shell.overlay` 槽位（右下角悬浮层）。

**npm（推荐）**

```bash
dsh plugin add dsh-nokia-pinball
```

或在 DeepSeek Harness GUI 的插件管理里搜索安装 `dsh-nokia-pinball`。

**GitHub 源码**

```bash
git clone https://github.com/zhanghao3693/dsh-nokia-pinball.git
dsh plugin add ./dsh-nokia-pinball
```

安装后刷新 Web GUI，右下角出现「弹珠台」按钮即生效。
卸载用 `dsh plugin remove dsh-nokia-pinball`，不会残留配置。

## 结构

```
dsh-nokia-pinball/
├── package.json        # dsh.bundle.patch + dsh.client.platform=web
├── cordis.patch.yml    # - insert: id: nokia-pinball / name: dsh-nokia-pinball
├── index.js            # Host 空壳（顶层不碰 window/document）
├── client.js           # 全部游戏逻辑 + React 组件 + 内联 CSS
├── icon.svg
├── README.md
└── LICENSE
```

`client.js` 通过 `window.__ModuleLoader__.load({ id, factory(require){...} })`
加载，用 `require("react")` 取 React，渲染树里内联 `<style>`，不依赖构建步骤。
物理内核（`createGame` / `launchBall` / `step` / `draw`）是无副作用纯函数，
挂在 `__internals` 上，可在 Node vm 沙箱里无头测试。

## 兼容性与层级

- 主题：用 `--dsw-alias-*` token 并全部带 fallback，深浅色主题都能看；
  浅色下另有 `body:not([data-ds-dark-theme])` 降饱和覆盖。
- 层级：`.np-root` 用 `z-index: 2147483001`，压过同层 dpharness 胶囊
  （2147483000）与三国志插件，避免「点不开」。
- 显示不全：面板用 flex column + `min-height:0` + `overflow-y:auto`，
  画布容器不会被内容顶出裁切区。

## License

MIT
