# X Media Picker — 按住 Alt 点击即入列

浏览器扩展（Chrome / Edge，MV3）。**按住 `Alt` 点图片或视频**：把该媒体的原始地址加入下载列表；再 Alt 点同一个 → 移出。**不按 Alt 时，页面行为完全不变** —— 不拦事件、不改样式、不弹任何东西。

## v1.5 修的是什么

「全站版」之前名不副实：它只认 X 的逻辑，别的站点几乎什么都不做。现在把通用能力补到**页面自己暴露的直链**为止，不猜站点 API：

| 站点情况 | 通用版能不能拿 |
|---|---|
| 普通 `<img>`（含 `srcset`） | ✅ 最大尺寸 |
| 懒加载图：`src` 是占位符、真地址在 `data-src` / `data-original` / `data-lazy-src` | ✅ |
| 用 CSS `background-image` 画的图 | ✅ |
| `<video>` 的 `src` 是 `http(s)` 直链 | ✅ |
| MSE / `blob:` 视频（YouTube、B站、多数播放器） | ⚠️ 只有页面写了 `og:video` / `og:video:secure_url` / `twitter:player:stream` 时才拿得到 |
| `<canvas>` 绘制的画面 | ❌ |
| X 的帖子（含 blob 视频） | ✅ 走专用解析，见上文 |

也就是说：**通用版 = 通用图片抓取 + 公开元数据兜底，视频能不能拿取决于站点有没有把地址写进 meta。** X 那种"用帖子 id 反查 mp4"的能力，通用版做不到 —— 那需要站点专用逻辑，不能靠猜。

两个包的分工因此很清楚：

- `-x-only.zip`：**推荐**。权限小，能力完整（Video 解析 + 原图 + GIF）。
- 全站版：适合抓图片/图集，别指望它在视频站上有什么奇迹。

## v1.4 修的是什么

**点视频本体没反应，点帖子别处才有链接。** 这是命中测试的问题，不是拦截的问题。

X 上视频的可点击区域是一层覆盖 `div`，它和 `<video>` 是**兄弟节点**，不是子节点。旧逻辑只做两件事：从点击目标 `closest('img, video, picture')` 往上找，以及在同一节点内 `querySelector`。从覆盖层出发这两条都落空 —— 于是 `resolveElement` 返回 `null`，`handle()` 直接 return，什么也不做（连 `preventDefault` 都没有）。而点在帖子里别的元素上时，祖先链能兜到图片，所以反而"点帖子才有反应"。

现在的搜索顺序：

1. 直接命中 `video` / `img` / `picture`；
2. 命中已知播放器容器（`[data-testid="videoPlayer"]` 等）时取容器里的 `<video>`；
3. **向上逐层** `querySelector('video')`，最多 7 层，遇到 `<article>` 就停 —— 既能把覆盖层和 video 对上，也不会伸进相邻帖子；
4. 最后才看"链接本身指向媒体文件"的情况。

同时修掉一个反向误伤：向上查找只找 `video`，不再顺手 `querySelector('img')`，所以点帖子空白处不会莫名其妙把作者头像加进列表（这条有断言）。

## v1.3 修的是什么

按住 Alt 没有十字准星和悬停高亮。两个原因叠在一起：

1. **`cursor: crosshair` 写在 `<html>` 上没用。** cursor 虽然继承，但 X 给自己的 `img` / `a` 都写了 `cursor: pointer`，子元素自己的声明会盖掉继承值 —— 准星永远到不了图片上。
2. **`:hover` 悬停的往往不是媒体本身。** 视频区域上面盖着一层透明 div，`img:hover` 根本不触发，所以描边也不出现。

改法：不再依赖 `:hover` 和继承，改成 **JS 驱动 + 直接打在元素上**：

- 按住 Alt 时监听 `pointermove`，用 `elementFromPoint` 找到光标下的节点，沿着父级最多找 4 层，解析出真正的媒体元素；
- 给它加 `data-xmp-hit` 属性，CSS 里 `[data-xmp-hit] { outline: …; cursor: crosshair !important; }` —— 直接作用于该元素，盖过页面自己的 cursor；
- 另外对 `img/video/picture/a:has(img)` 也补一条 `!important` 的 crosshair，覆盖没被标记到的区域；
- 松开 Alt 清掉标记。

## 自查：popup 顶部现在有一行状态

打开扩展图标，顶部会显示：

- 绿色 `本页脚本已注入 · v1.3.0` → 脚本活着
- 红色 `本页未注入（扩展 v1.3.0）` → 页面需要刷新，或扩展没重新加载

之前「Alt 没反应」最难判断的就是"到底跑没跑"，现在一眼就能分清。

## v1.2 修的是什么

Alt 点视频，列表里进的却是「帖子」，而不是视频。原因很直接：X 用 MSE 播放，`<video>` 的 `src` 是 `blob:https://x.com/...` —— **浏览器自己的「复制视频地址」在这里也只能给出 blob**，没有任何可下载的东西。之前的版本遇到 blob 就把帖子链接塞进列表收工。

现在的做法是「右键拿不到就去问源头」：

1. 先读元素（和右键菜单同一条路）：`video.currentSrc || video.src`、`img.currentSrc || img.src`、`<source>`、`srcset` 最大项；
2. 如果拿到的是 `blob:` 或只是封面帧，就取所在帖子的 `/status/<id>`；
3. 用这个 id 去查帖子数据（`cdn.syndication.twimg.com` → `api.fxtwitter.com` 兜底），挑出**分辨率最高的 MP4** 写进列表；
4. 全部失败才退回帖子链接，并明确提示「解析失败」。

所以现在 Alt 点视频，入列的就是 `https://video.twimg.com/.../1920x1080/xxx.mp4`，「下载全部」直接下视频。

## v1.1 修的是什么

第一版装上后「Alt 点了没反应、视频照样打开」，有两个真问题，都改了：

1. **脚本其实没跑起来。** 原来 `content.js` 用动态 `import()` 去取 `pick.js`。Chrome 会对 content script 的 `import()` 按**宿主页面的 CSP** 校验，x.com 的 CSP 不允许 `chrome-extension:` 源，import 被拒；而代码里只有一句 `console.warn` 然后 `return` —— 于是扩展**完全静默地失效**，表现就是"什么都没发生"。
   → 现在 `pick.core.js` 由 manifest 顺序注入（经典脚本，挂 `globalThis.XMPPick`），不再有运行时 import；万一还是缺，页面左下角直接显示红条报错，不会再静默。
2. **只拦 `click` 拦不住 X。** X 在 `pointerdown` / `pointerup` 上就打开播放器了，`click` 阶段已经太晚。
   → 现在从 `pointerdown` 开始整段手势都拦：`pointerdown` / `pointerup` / `mouseup` / `click` / `auxclick` 全部 `preventDefault + stopImmediatePropagation`，并在 `pointerdown` 里完成入列（取消 `pointerdown` 也会阻止浏览器合成后续 `click`）。键盘触发的 `click`（前面没有 pointerdown）仍然生效。

**还要在扩展页点一次「重新加载」** —— manifest 变了（版本 1.1.0，注入文件列表变了）。

## 装

1. 打开 `edge://extensions`（Chrome 是 `chrome://extensions`）
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选 `E:\DarkestSexDungeon\x-media-picker`
4. 已装过旧版的：点该扩展卡片上的「重新加载」（↻）

想用本地 `demo.html` 验证，就在扩展详情里打开「允许访问文件 URL」。

## 用

| 操作 | 结果 |
|---|---|
| `Alt` + 点图片 | 入列，URL 升级成 `?format=<真实后缀>&name=orig` |
| `Alt` + 再点同一张 | 移出（按 media id 判重，尺寸参数不同也认作同一个） |
| `Alt` + 点头像 | 升级成 `_400x400`（X 只保留这个尺寸） |
| `Alt` + 点视频 | 直链 mp4 入列；`blob:` 流 → 用帖子 id 解析出真实 MP4 再入列 |
| `Alt` + 点视频封面（thumb） | 不入列封面，同样解析出该帖的真实 MP4 |
| 普通点击 | 什么都不发生 |
| 点扩展图标 | 看列表：单条删除 / 下载全部 / 复制链接 / 导出 .txt / 清空 |

按住 Alt 时：鼠标变十字、悬停的媒体描蓝框、帖子链接描绿虚线框，**右下角出现 `ALT · N` 角标**（N 是当前列表条数）。

## 怎么判断插件活没活

按住 Alt 看右下角：

- **有 `ALT · N` 角标** → 脚本在跑。此时 Alt+点媒体没反应就是元素识别没命中。
- **没有角标** → 脚本没注入。打开 popup 看顶部那行状态，红字会直接告诉你。

popup 的红字还有一种情况：扩展已更新但**当前标签页是更新前打开的**，刷新页面即可。

## 按住 Alt 时应该看到什么

- 鼠标变成十字准星（光标下的图片/视频区域）；
- 悬停的媒体描一圈蓝框；
- 右下角出现 `ALT · N` 角标；
- Alt+点击后右下角弹出「已加入 / 已解析为视频 1920x1080」。

四项里只要角标出现，就说明脚本活着、只是命中问题，把现象告诉我即可定位。

## 落盘与"原图"

「下载全部」走浏览器原生下载（`chrome.downloads`），保存到浏览器默认下载目录。

X 的 CDN 偶尔会对超大图拒绝 `name=orig`（404）。这种情况扩展会**自动用 `name=large` 重试一次**。视频直链直接下，不做转码。

## 为什么有些点击记的是"帖子"

只有一种情况：帖子数据也拿不到（受保护账号、已删除、区域限制、接口抖动）。这时列表里会留一条绿色「帖子」标签，tab 上会明确写「解析失败」。把它交给 `x_media` / `xmd` 仍能再试一次：

```
node E:\DarkestSexDungeon\x-media\bin\xmd.js "https://x.com/SpaceX/status/1732824683784516" -o D:\x
```

正常情况不会走到这里 —— Alt 点视频得到的就是 MP4 直链。

## 分发

```powershell
node tools/package.mjs
```

输出到 `dist/`：

| 包 | 说明 |
|---|---|
| `x-media-picker-v1.4.0.zip` | 全站版，`<all_urls>` 注入 |
| `x-media-picker-v1.4.0-x-only.zip` | 只在 x.com / twitter.com 注入（**推荐发给别人**），但仍保留 `*.twimg.com`、`api.fxtwitter.com` 的权限，否则 service worker 解析 mp4 会被 CORS 拦住 |

zip 里附带 `INSTALL.md`（面向接收方的安装说明）。打包脚本零依赖，手写 ZIP（deflate + CRC-32），时间戳固定，重复构建字节一致。

接收方拿到 zip 后的三步：解压 → `edge://extensions` 开启开发者模式 → 「加载解压缩的扩展」选文件夹。

> 开发模式安装的扩展，Chrome 每次重启会提示「停用开发者模式扩展」，点保留即可；Edge 一般不提示。
> 想彻底摆脱这个提示，只能上架 Edge Add-ons（免费）或 Chrome Web Store（一次性 $5）。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 清单；`content_scripts` 顺序注入 `pick.core.js` → `content.js` |
| `pick.js` | **唯一源**的纯逻辑：URL 分类、原图升级、srcset 取值、判重、toggle（ESM，给 Node 测试用） |
| `pick.core.js` | 由 `tools/build-core.mjs` 从 `pick.js` **生成**的经典脚本版，挂 `globalThis.XMPPick`；content script 用的就是它 |
| `content.js` | 事件绑定：Alt 追踪、高亮、`ALT · N` 角标、整段指针事件拦截、toast（shadow DOM） |
| `resolve.js` | 帖子 id → 真实媒体地址（syndication + fxtwitter 兜底），service worker 用 |
| `background.js` | 列表持久化、徽标数字、`post` 条目解析成 MP4、批量下载 + 大图降级重试 |
| `popup.html/.css/.js` | 列表面板 |
| `demo.html` | 本地试验页：真图片、封面图、blob 视频、直链 mp4 四种情形 |
| `tools/make-icons.mjs` | 零依赖生成 `icons/*.png`（手写 PNG 编码 + zlib） |
| `tools/build-core.mjs` | 生成 `pick.core.js` |
| `tools/package.mjs` | 打两个分发 zip 到 `dist/` |
| `INSTALL.md` | 给接收方的安装说明（随 zip 分发） |

## 测试

```powershell
node test/pick.mjs        # 35 项：URL 分类 / 原图升级 / 封面识别 / srcset / 判重 / toggle
node test/content.mjs     # 25 项：假 DOM + 假 chrome，跑真实 content.js
node test/resolve.mjs     # 16 项：帖子 → 最高分辨率 mp4 / gif 标记 / 图片原图 / 双后端兜底
node test/background.mjs  # 15 项：真实 background.js + 假 chrome，验证 blob 视频最终入列的是 mp4
node test/core-sync.mjs   # pick.core.js 是否与 pick.js 同步
node test/e2e-edge.mjs    # 真浏览器端到端（需本机装了 Edge，约 15 秒）
```

### 端到端（`test/e2e-edge.mjs`）

不碰你正在用的浏览器：脚本自己起一个 Edge，**独立 `--user-data-dir`**、headless、装上扩展，用 CDP 派发真实键鼠事件（`rawKeyDown Alt` → `mouseMoved` → `mousePressed/Released` with `modifiers:1`），再从 content script 的 isolated world 里读 `chrome.storage.local` 断言结果。

它验证的就是「Alt 到底有没有用」：

| 断言 | 意义 |
|---|---|
| `Alt keydown puts the page in pick mode` | 按 Alt 真的进了拾取模式 |
| `hovering marks the media element` + `IMG\|crosshair` | 悬停命中媒体元素，且**计算样式真的是 crosshair** |
| `Alt+click added exactly one entry` + `…name=orig` | 入列的是原图地址 |
| `plain click changes nothing` | 普通点击不改列表（正常浏览不受影响） |
| `poster click resolved to the real MP4` | **点封面 → 列表里是 `video.twimg.com/…/1920x1080/…mp4`，不是帖子链接** |
| `clicking the video body targets the same MP4` | **点 `<video>` 本体命中同一个 mp4**（修的就是这条） |
| `releasing Alt restores the page` | 松开 Alt 页面复原 |

`poster → MP4` 那一条依赖外网；解析器不可达时会打印 `skip` 而不是假装通过。

**仍然没验证的**：你本机那套 Edge 配置里的实际表现（扩展可能被企业策略限制、或与其它扩展冲突）；以及 x.com 线上 DOM 与 `demo.html` 的差异 —— 后者只能你在真实页面上点一次确认。

## 已知边界

- `all_frames: false`，嵌在 iframe 里的媒体点不到；
- 不解析 `<canvas>` 绘制的媒体（极少见）；
- 列表存在 `chrome.storage.local`，卸载扩展即丢；
- 各站点都用 `<all_urls>` 注入，但只在按住 Alt 且命中媒体时才有动作。
