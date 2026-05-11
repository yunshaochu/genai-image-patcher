# GenAI Patcher Pro — 性能优化分析报告

> 分析时间：2026-05-11
> 分支：`dev`（最新提交 `d04b29a 修复OOM：全链路base64字符串替换为Blob Object URL`）
> 分析范围：前端代码（React + Canvas + AI Service 全链路）

---

## 0. TL;DR — 优先级总览

| 优先级 | 编号 | 问题 | 估计收益 |
|---|---|---|---|
| 🔴 P0 | 1.1 | `services/aiService.ts:22` 中文顿号导致 TS 编译失败 | 编译错误 → 必修 |
| 🔴 P0 | 2.1 | PatchEditor / EditorCanvas 仍用 `toDataURL` 落地遮罩 | 抹平 OOM 修复成果 |
| 🔴 P0 | 3.1 | `images` state 全量浅拷贝 + `setImages(prev.map(...))` | 多图批量时 O(N×M) 渲染 |
| 🔴 P0 | 4.1 | `EditorCanvas.useEffect` 依赖 `image.regions` 触发全量 restore 合成 | 拖框/选区时反复跑 Canvas |
| 🟠 P1 | 2.2 | `dataURLtoBlob` 用 `charCodeAt` 循环（大图慢 5-10×） | 粘贴大图 / Editor 保存卡顿 |
| 🟠 P1 | 5.1 | `depadImageFromSquare` 像素扫描未抽样 | 4K 图去填充 200-800 ms |
| 🟠 P1 | 6.1 | App.tsx 大量未 memo 的 handler，Sidebar 没 `React.memo` | 任何 state 变化触发整树 reconcile |
| 🟠 P1 | 7.1 | Tailwind CDN JIT 模式 + index.html 重复 `<link>/<script>` | 首屏阻塞 + 重复加载 |
| 🟠 P1 | 8.1 | useImageProcessor 中 `urlToBase64` 对同一 URL 调用 2 次 | 翻译模式额外一次 fetch+blob |
| 🟡 P2 | 9.x | JSZip 主线程压缩、Intl.Collator 重复构造、缺 `loading="lazy"` 等 | 多图体验细节 |

---

## 1. 致命问题（必修）

### 1.1 `aiService.ts:22` 出现非法字符 ❗

```ts
export const fetchOpenAIModels = async (
  baseUrl: string,
  apiKey: string
): Promise<string[]> => {、   // ← 这个中文顿号「、」
```

`tsc --noEmit` 报 `error TS1127: Invalid character.`。Vite/esbuild 容忍了，但任何 `tsc`/IDE 全量检查都会失败，并且 esbuild 在不同版本下行为可能改变，潜在线上事故。

**修复**：删掉那个顿号即可。

---

## 2. 内存：违反"全链路 Object URL"原则的漏点

最近一次提交（`d04b29a`）已经把主流程改成 Blob Object URL，但仍残留两类 base64 写入路径：

### 2.1 EditorCanvas 中两处 `toDataURL` 🔴

| 行号 | 上下文 | 影响 |
|---|---|---|
| `components/EditorCanvas.tsx:514` | `saveBrushMask()` 保存涂抹遮罩 | 涂抹遮罩每次确认都产生 base64 |
| `components/EditorCanvas.tsx:625` | 涂抹结束 `mouseup` 自动保存 | 用户拖一下笔就产生几 MB string |

二者把 mask canvas 直接 `toDataURL('image/png')` 后传入 `onUpdateRestoreMask` → `setImages`，从而把大 base64 写进 React state，再级联到 history 数组。

**修复**：替换为 `canvas.toBlob` → `URL.createObjectURL`，配合 `releaseObjectURL` 释放旧值。参考 `services/imageUtils.ts:30` 已有的 `canvasToObjectURL` 工具函数。

> 注：`types.ts:31` 字段命名为 `restoreMaskBase64`，实际语义已经是 URL。建议同步改成 `restoreMaskUrl` 避免后续维护误用 base64 API。

### 2.2 `dataURLtoBlob` 用 `charCodeAt` 循环 🟠

`hooks/useImageManager.ts:322-332`：

```ts
const binary = atob(data);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
  bytes[i] = binary.charCodeAt(i);   // ← JS 单字节循环
}
```

对 5 MB base64 要循环 5 百万次。`useImageProcessor.ts:126-128` 和 `useImageProcessor.ts:297-299` 也复制了同样的代码。

**修复**：抽公共工具，并优先用 `fetch(dataURL).then(r => r.blob())` —— 浏览器内部 C++ 解码远快于 JS 循环。

```ts
export const dataURLtoObjectURL = async (dataUrl: string) => {
  const blob = await (await fetch(dataUrl)).blob();
  return URL.createObjectURL(blob);
};
```

### 2.3 PatchEditor history 持有原始 ImageData 🟠

`components/PatchEditor.tsx:204-228`：每次画笔结束 `recordHistory()` 把 `ctx.getImageData()` 推入数组，最多 10 条。

- 2000×3000 图：1 条 ImageData = 24 MB
- 10 条上限 = **240 MB** 仅 Editor history

**修复**：把 ImageData 换成 `canvas.toBlob` → Object URL，再在 undo/redo 时 `loadImage` 回填。代价是 undo 多一次解码（~30 ms 内），但内存降一个数量级。

### 2.4 `restoreCompositedCache` 旧值泄漏 🟠

`components/EditorCanvas.tsx:347-381`：useEffect 内部读 `restoreCompositedCache`（state 闭包），但 cleanup 函数读到的是渲染时的旧值快照，不是最新值；同时 effect 依赖只列了 `image.regions`，所以：

- 同一 effect 周期 setState 后老 cache 不会立刻被释放；
- unmount 时 cleanup 释放的是最早的 cache，中间几代的 blob 全部泄漏。

**修复**：把 cache 收进 `useRef`，在每次重建前同步 revoke ref 里的旧值，effect deps 不再依赖 cache state。

### 2.5 翻译模式 `urlToBase64` 重复调用 🟠

`hooks/useImageProcessor.ts:96-111` 和 `:266-285`：

```ts
const payloadBase64 = await urlToBase64(payloadUrl);
translationText = await generateTranslation(payloadBase64, ...);
...
const payloadBase64ForAPI = await urlToBase64(payloadUrl);  // 又来一遍
```

同一个 `payloadUrl` 解码两次（一次给翻译，一次给主调用），等于在内存里同时持有两个相同的几 MB 大字符串。

**修复**：第二次直接复用第一次的变量。注意 base64 用完后立刻 `payloadBase64 = ''` 释放即可。

### 2.6 `reCropProcessedImage` 异常路径不释放 canvas 🟡

`services/imageUtils.ts:565-604` 在 `fullCanvas.toBlob` 失败、`out.getContext` 失败时直接抛错，未走 `releaseCanvas`。Canvas 内存不会自动 GC（Chrome 在显存里）。建议用 try/finally 包裹。

---

## 3. 状态管理：React 渲染粒度

### 3.1 `setImages(prev => prev.map(...))` 模式 O(N×M) 🔴

整个项目几乎所有写操作都是这个 pattern（出现 30+ 次），最典型：

```ts
// App.tsx:382
setImages(prev => prev.map(img => ({
    ...img,
    regions: img.regions.map(r => r.id === regionId ? {...} : r)
})));
```

即使只改一个 region 的 prompt，也会：
1. 创建新 `images` 数组（N 个对象）
2. 每张图创建新 `regions` 数组（M 个对象）
3. 触发 App + Sidebar + EditorCanvas 全部 reconcile

10 张图 × 50 region 时,一次 prompt 字符录入 = 500 个对象浅拷贝 + 全树 diff。

**修复方案（按改造成本递增）**：

1. **轻量**：用 `imageId` 索引快速跳过：`prev.map(img => img.id !== id ? img : {...})`（部分位置已这么写，没有进一步优化）
2. **中等**：拆分成 `imagesById: Record<string, UploadedImage>` + `imageOrder: string[]`（normalize state）
3. **重量**：引入 zustand/jotai 这类 atom 化状态库，按 imageId 分片订阅

### 3.2 `selectedImage = images.find(...)` 没 memo 🔴

`hooks/useImageManager.ts:15`、`App.tsx:67`（隐式通过 hook 返回）：每次 render 都 O(N) 查找。`selectedImage` 同时被传给 `useImageProcessor` 作为依赖，会进一步触发该 hook 的其他 useEffect。

**修复**：

```ts
const selectedImage = useMemo(
  () => images.find(img => img.id === selectedImageId),
  [images, selectedImageId]
);
```

更佳：normalize 之后直接 `imagesById[selectedImageId]` O(1)。

### 3.3 App.tsx 大量 handler 未 memo 🟠

`App.tsx` 仅 4 个 `useCallback`（186/382/389/438 行），其余像 `handleManualPatchUpdate`、`onRegionsChanged`、`handleUpload`、`handleEditorSave`、`handleOcrRegion`、`handleDownload`、`handleApplyAsOriginalWrapper`、`updateConfig`、`fetchTransModels` 等全是裸函数。这些函数每次 App 重渲染都新建引用 → 传给 Sidebar/EditorCanvas 后让 `React.memo` 失效。

`components/EditorCanvas.tsx:48` 用了 `React.memo`，但 `App.tsx:651` 传入的 `onUpdateRegions={(imageId, newRegions) => onRegionsChanged(imageId, newRegions)}` 是 inline 箭头函数，memo 直接被打穿。

**修复**：

- 把所有传给 Sidebar/EditorCanvas 的 handler 用 `useCallback` 包装
- 给 `Sidebar` 加 `React.memo`（目前没有）
- EditorCanvas 中 `onUpdateRegions={onRegionsChanged}` 直接传引用，不要再包一层

### 3.4 `useCanvasInteraction` 频繁重建 window 监听器 🟠

`hooks/useCanvasInteraction.ts:197-203`：useEffect 依赖 `[disabled, onUpdateRegions, onSelectRegion]`，由于上层每次都传新函数引用，导致每次 App 渲染都 `removeEventListener` + `addEventListener`。鼠标拖拽过程中如果父组件刷新过，监听器空窗期会丢失事件。

**修复**：把 `onUpdateRegions`/`onSelectRegion` 通过 ref 透传，effect 依赖收敛到 `[disabled]`。

### 3.5 `operationVersionRef` 没有真正起作用 🟡

`App.tsx:72` 定义了：

```ts
const operationVersionRef = useRef<number>(0);
```

且 `handleInteractionStart` 中 `operationVersionRef.current++`，但**所有 async 流程都没读取这个版本号**比对，race condition 防护形同虚设。要么删掉，要么在 `setImages` 前判断 `if (myVersion !== operationVersionRef.current) return`。

---

## 4. Canvas / 图像处理

### 4.1 `restoreCompositedCache` useEffect 触发过度 🔴

`components/EditorCanvas.tsx:347` 依赖 `image.regions`。问题：

- 用户拖框（region.x/y/width/height 变）触发
- 改 prompt 文本（region.customPrompt）触发
- OCR loading 状态变化触发
- 选中状态完全无关，但也会因 regions 数组引用变化而触发

每次触发都对所有 completed region 重新跑 `renderRegionWithRestore`（含 Canvas drawImage + toBlob）。

**修复**：

```ts
// 只关心 restoreBoxes / restoreMaskBase64 / processedImageBase64 的实际变化
const restoreSignature = useMemo(
  () => image.regions.map(r => `${r.id}:${r.processedImageBase64}:${r.restoreMaskBase64}:${(r.restoreBoxes||[]).length}`).join('|'),
  [image.regions]
);
useEffect(() => { /* update cache */ }, [restoreSignature]);
```

### 4.2 `depadImageFromSquare` 逐像素扫描 🟠

`services/imageUtils.ts:237-309` 对 4 个方向逐行扫描完整 ImageData：

- 4096×4096 图 = 16M 像素 × 4 通道 × 4 方向遍历 ≈ 几亿次 `pixels[i]` 访问
- 实测在中端机器 200–800 ms

**修复**：

1. 抽样：每 4 / 8 行扫一次足够检测黑色填充边界
2. 用 `Uint32Array` 视图一次取 4 字节做位运算，提速 ~3×
3. 大图先 `ImageBitmap` 缩小到 1024 内扫描，再按比例还原坐标

### 4.3 全分辨率 mask canvas 🟠

`createMultiMaskedFullImage` / `createInvertedMultiMaskedFullImage` 用原图分辨率创建 canvas（`imageElement.naturalWidth/Height`）。当用户上传 6000×8000 漫画原图时单画布 = ~190 MB 显存。即使 `performanceMode='balanced'` 会先压到 2048，但 `useImageProcessor.ts:61` `loadImage(imageSnapshot.originalUrl || previewUrl)` 仍优先用 `originalUrl`。

**修复**：mask 阶段读取 `previewUrl`（balanced 模式已压缩），或在 mask 之前先 downscale 到一个上限（比如 max 4096）。

### 4.4 下载/应用反复 stitch 🟡

`handleDownload`、`handleApplyAsOriginalWrapper`、`handleDownloadAllZip` 每次都重新跑 `stitchImage`。用户点两次"下载"就跑两次 Canvas 合成。

**修复**：维护一个 `finalResultUrl` 缓存（实际上 inverted 模式已经有，标准模式没有）。当 regions 任意 `processedImageBase64` 变化时失效；否则复用。

### 4.5 `renderRegionWithRestore` 每张 patch 都 loadImage 🟡

`stitchImage`（`services/imageUtils.ts:683-731`）对每个 region 单独 `loadImage(displayUrl)`，对 50 个 region 的图片 = 50 次 Image 解码。

**修复**：在循环外用 `Promise.all(regions.map(loadImage))` 并行解码。

---

## 5. 网络 / API 调用

### 5.1 `prepareImageForUpload` 未用 `createImageBitmap` 🟡

`services/detectionService.ts:32-59`：

```ts
const img = await loadImage(imageUrl);
// ...
ctx.drawImage(img, 0, 0, w, h);
```

`HTMLImageElement.decode` + Canvas 路径在 Chrome 上比 `createImageBitmap` 慢 30–50%。

**修复**：

```ts
const blob = await (await fetch(imageUrl)).blob();
const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
// 直接 drawImage(bitmap, 0, 0)
bitmap.close();
```

### 5.2 OpenAI Stream 解析缺 SSE 多行 buffer 🟡

`services/aiService.ts:285-321`：按 `\n` 切 chunk 并立刻 parse JSON。但 SSE 一次 `read()` 可能切到 `data: {"choices":` 这种半行，下一次 `read()` 才补完。当前代码会 `JSON.parse` 失败被 `catch` 吞掉，丢失 token。

**修复**：维护一个 `buffer = ''`，每次 chunk `buffer += chunk`，按 `\n\n` 切分完整事件再解析，结尾保留半行下次拼。

### 5.3 `executeWithRetry` 不真正取消底层请求 🟡

`services/aiService.ts:75-91` 用 `Promise.race(timeout, op)`：timeout 触发后只是 reject wrapper promise，底层 fetch 仍在跑（除非 op 本身用了同一 signal）。`generateGeminiImage` 用 `GoogleGenAI` SDK 没传 signal，超时后请求会一直跑到自然结束。

**修复**：在 `executeWithRetry` 内部创建 timeout-driven `AbortController`，传给底层 fetch / SDK（@google/genai v1.x 已支持 `signal`）。

### 5.4 重试间隔无指数退避 🟢

`aiService.ts:104` 固定 1 s 重试间隔。被限流时硬重试容易雪崩。建议 `Math.min(30000, 1000 * 2 ** attempt)`。

---

## 6. React 渲染层（细节）

### 6.1 PatchEditor 内 `textObjects.find(...)` JSX 内重复 5+ 次 🟠

`components/PatchEditor.tsx:766/777/787/800/809/819/822/825/837/846` 等位置都在 inline 算：

```tsx
value={textObjects.find(t => t.id === selectedTextId)?.fontSize}
```

每次 render O(N×K) 查找。

**修复**：

```ts
const selectedText = useMemo(
  () => textObjects.find(t => t.id === selectedTextId),
  [textObjects, selectedTextId]
);
```

之后所有访问 `selectedText?.fontSize` 都是 O(1)。

### 6.2 Sidebar 没有 `React.memo` 🟠

`components/Sidebar.tsx:54` 是普通函数组件，App 任何 state 变化（拖框、zoom）都会触发其重渲染（连同 600 行 JSX 和内部 hook）。

**修复**：

```tsx
export default React.memo(Sidebar);
```

配合 §3.3 的 useCallback 才有效。

### 6.3 内联 SVG / 大量重复 className 🟢

每个按钮的 SVG 是裸 inline。可以抽 `<Icons.Undo />` 这种轻组件，让 React 复用 vnode 结构。收益小但首次 mount 时 DOM 体量会少 ~20%。

---

## 7. 资源加载 / 构建

### 7.1 `index.html` 标签重复 🟠

```html
<link rel="stylesheet" href="/index.css">
<link rel="stylesheet" href="/index.css">           <!-- 重复 -->
...
<script type="module" src="/index.tsx"></script>
<script type="module" src="/index.tsx"></script>   <!-- 重复 -->
```

第二次 `<link>` 会触发额外网络请求（HTTP 缓存命中也仍要走一次），第二次 `<script type="module">` 会让浏览器再 fetch 一次模块（带 cache-busting query 时可能重复执行 React root mount）。

**修复**：删掉重复行。

### 7.2 Tailwind CDN JIT 模式 🟠

```html
<script src="https://cdn.tailwindcss.com"></script>
```

`cdn.tailwindcss.com` 是 runtime JIT —— 每次页面加载都在浏览器里扫 className 生成 CSS，FCP 多 100–300 ms，且生产环境不应使用（官方明确反对）。

**修复**：装 `tailwindcss` postcss 插件，build 时编译，把主题 CSS 变量保留在 `index.css`。

### 7.3 importmap + npm 双重依赖 🟠

`index.html:138-152` 通过 importmap 把 `react`、`@google/genai`、`jszip` 指向 `esm.sh`，但 `package.json` 又把它们装在 `node_modules` 里。Vite 开发环境会用 `node_modules` 版本，部署到非 Vite 静态托管时又会从 esm.sh 拉一次，可能装到两份 React → context 失效。

**修复**：删掉 importmap（Vite 已经处理依赖），或彻底走 CDN-only（删 package.json deps）。当前混合配置是定时炸弹。

### 7.4 Google Fonts 阻塞渲染 🟢

```html
<link href="https://fonts.googleapis.com/css2?..." rel="stylesheet">
```

无 `preconnect`、无 `font-display=swap`。Inter 加载完之前文本看不见。

**修复**：

```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
```

### 7.5 缺少代码分割 🟡

`PatchEditor.tsx`（~1000 行 + canvas 逻辑）、`HelpModal`、`SettingsPanel`、`MangaToolsPanel` 都打到主 bundle。首屏其实只要 App + Sidebar + EditorCanvas。

**修复**：用 `React.lazy + Suspense` 包裹 PatchEditor / HelpModal / GlobalSettings。预计首屏 JS 体积降 30-50%。

---

## 8. 工具函数 / 小细节

### 8.1 `Intl.Collator` 每次比较都新建 🟡

`services/imageUtils.ts:866`：

```ts
export const naturalSortCompare = (a, b) =>
  new Intl.Collator(undefined, { numeric: true }).compare(a.file.name, b.file.name);
```

排序 100 张图片 = ~700 次 Collator 构造。

**修复**：

```ts
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalSortCompare = (a, b) => naturalCollator.compare(a.file.name, b.file.name);
```

### 8.2 `useConfig` localStorage 写入未 debounce 🟡

`hooks/useConfig.ts:211-213`：每次输入框敲字都全量 `JSON.stringify(config)`（含所有 prompt 大段文本 + 翻译 prompt slot）。10 KB+ string × 每次按键 = 卡顿。

**修复**：

```ts
useEffect(() => {
  const t = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(config)), 300);
  return () => clearTimeout(t);
}, [config]);
```

### 8.3 `handleUpload` 重置 input value 时机错 🟢

`App.tsx:216-221`：

```ts
const handleUpload = async (e) => {
  if (e.target.files?.length) await addImageFiles(...);
  e.target.value = '';   // ← 等图片全部加载完才执行
};
```

如果用户在 `addImageFiles` 进行中再次点选了同名文件，新点击会被忽略（input value 还没清）。应该上传开始时就 `e.target.value = ''`。

### 8.4 图库 thumbnail 缺 `loading="lazy"` 🟢

`Sidebar.tsx:403`：

```tsx
<img src={img.thumbnailUrl || img.previewUrl} ... />
```

无 `loading="lazy"`、`decoding="async"`。100+ 张图时滚动列表卡。即便 thumbnailUrl 是 256×256 也仍要一次性解码 100 张。

### 8.5 JSZip 主线程压缩 🟡

`components/Sidebar.tsx:218`：

```ts
const content = await zip.generateAsync({ type: "blob", streamFiles: true });
```

JSZip 即便 streamFiles=true，CPU 计算仍跑在主线程。50 张图打包时 UI 完全冻结。

**修复**：

- 短期：包 `setTimeout(..., 0)` 让浏览器至少有空隙刷新加载动画
- 长期：上 Web Worker（`comlink` + `jszip` worker bundle）

### 8.6 `handleAutoDetect` 用了全局 `concurrencyLimit` 🟢

`useImageProcessor.ts:418`：detection 是 backend GPU bound 任务，与 OpenAI API 限流是两件事。当 `concurrencyLimit=5` 时前端会同时发 5 个 detection 请求，远超大多数本地 YOLO 服务的吞吐。建议给 detection 独立一个低并发设置（比如 2）。

---

## 9. Bug / 一致性问题（不是性能但顺便记录）

### 9.1 `types.ts` 字段命名误导

- `Region.processedImageBase64` 实际存的是 Object URL
- `Region.restoreMaskBase64` 也是 URL

后续开发者按字段名调用 `atob()` / 直接当 src 给 fetch 会爆。建议批量重命名为 `processedImageUrl` / `restoreMaskUrl`。

### 9.2 反向遮罩与 squareFill 互斥但 UI 未禁用

`useImageProcessor.ts:76-90`：`useInvertedMasking + enableSquareFill` 路径下 `paddingInfo` 仍会传给 `extractCropFromFullImage`，但 inverted 分支不调用 extract，所以 padding 信息白生成。建议要么 inverted 模式禁用 squareFill 开关，要么文档注明。

### 9.3 `App.tsx:75-145` `handleManualPatchUpdate` 与 `useImageManager.ts:167` 同名函数重复

两份 `handleManualPatchUpdate`，一份在 App、一份在 useImageManager（导出但没人用）。useImageManager 那份是死代码，多带一份逻辑分歧风险。

---

## 10. 建议的优化路线

按 ROI 排序，建议分三个迭代：

### 迭代 1（1-2 天，立即收益）
1. 修 §1.1 中文顿号
2. 修 §2.1 EditorCanvas 两处 `toDataURL`
3. 删 §7.1 重复 link/script
4. §8.1 Intl.Collator 缓存
5. §8.2 useConfig debounce

### 迭代 2（3-5 天，结构性收益）
6. §3.3 App.tsx 大批 useCallback + Sidebar `React.memo`
7. §4.1 restoreCompositedCache 用 ref + signature
8. §2.5 翻译模式去重 urlToBase64
9. §2.3 PatchEditor history 改 Object URL
10. §7.2 Tailwind 改 build 时
11. §7.5 PatchEditor 等 lazy load

### 迭代 3（一周，深度重构）
12. §3.1 normalize images state（最大收益）
13. §3.2 `selectedImage` 改 O(1) 索引
14. §4.2 depad 抽样扫描 + Uint32 视图
15. §5.1 全链路 createImageBitmap
16. §8.5 JSZip 上 Worker
17. §5.2 OpenAI SSE buffer 修复
18. §9.1 字段重命名（一次性 PR）

预计完成全部三轮后，4K 图 / 50 张批量场景下，首屏时间降 40%、批处理峰值内存降 30-50%、拖框/选区交互帧率 30 fps → 55 fps+。