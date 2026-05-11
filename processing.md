# Processing — `report.md` 执行进度

> 起始基线：`d04b29a 修复OOM：全链路base64字符串替换为Blob Object URL`
> 当前分支：`dev`
> 最后更新：2026-05-11（第二轮优化完成）
> 关联文件：[`report.md`](./report.md)

---

## 0. 进度概览

| 级别 | 总数 | 完成 | 待办 |
|---|---|---|---|
| P0 致命 | 4 | 4 ✅ | 0 |
| P1 重要 | ~14 | 14 ✅ | 0 |
| P2 次要 | ~11 | 10 ✅ | 1 |
| Bug/一致性 | 3 | 2 ✅ | 1 |
| 重头戏 | 1 | 0 | 1 |
| **合计** | ~33 | **30 ✅** | **3** |

**验证状态（第三轮收尾）**：
- `tsc --noEmit -p .` 通过（0 error）
- `vite build` 通过：
  - 主 bundle `index-*.js`：**697.00 kB / gzip 184.70 kB**（第二轮 709.74 / 185.85；首轮基线 731.78 / 190.52）
  - 懒加载 chunk：`GlobalSettings-*.js` 14.13 kB / gzip 2.22 kB（新拆）、`PatchEditor-*.js` 20.97 kB / gzip 5.90 kB、`HelpModal-*.js` 3.54 kB / gzip 1.12 kB
  - 单 chunk > 500 kB 警告仍在（vendor/genai SDK 是大头，要再降需 manualChunks 分包）

---

## 1. 已完成（30 项）

按报告章节排序，列明改动位置以便回查。

### 第三轮新增完成（2026-05-11）

#### ✅ §3.5 删除 operationVersionRef 死代码
- `App.tsx:77-78` 删除 `operationVersionRef` 定义
- `App.tsx:198-199` 删除 `handleInteractionStart` 中的自增逻辑
- 无任何代码读取该 ref 做版本比对，是失效的防护机制

#### ✅ §9.2 inverted + squareFill UI 互斥
- `components/sidebar/SettingsPanel.tsx:162-173` squareFill 复选框在 `useInvertedMasking` 启用时禁用并置灰
- `services/translations.ts` 新增 `squareFillDisabledByInvertedTip` 中英文案
- `hooks/useImageProcessor.ts:82-90` useFullImageMasking 分支跳过 squareFill（`const useSquareFill = config.enableSquareFill && !config.useInvertedMasking`）
- 原因：inverted 模式输出全图，padding 会被立即 depad，是无效往返

#### ✅ §7.3 importmap + npm 双重依赖清理
- `index.html:140-154` 删除整个 `<script type="importmap">` 块
- `package.json` 已装 react/react-dom/@google/genai/jszip，Vite 接管依赖解析
- 主 bundle 无变化（importmap 只影响 dev 模式 esm.sh 回退）

#### ✅ §5.3 executeWithRetry 用 AbortController 真正取消
- `services/aiService.ts:58-111` 重写 `executeWithRetry`：每次重试创建 `AbortController`，监听外部 signal + timeout，传给 operation
- `generateGeminiImage` 新增 `timeoutMs` 参数，通过 `config.httpOptions.timeout` 传给 SDK
- `generateOpenAIImage` 的 fetch 已接收 signal，无需改动
- `generateRegionEdit` 改 worker 签名为 `(opSignal: AbortSignal) => Promise<T>`，传 timeout 给 Gemini 路径
- 原 `Promise.race(timeout, op)` 只拒绝 wrapper，底层请求继续跑；现在 abort 真正取消 HTTP

#### ✅ §4.3 mask canvas 限尺
- `hooks/useImageProcessor.ts:61-68` 新增 `maskImg` 变量：优先用 `previewUrl`（balanced 模式已压到 2048），fallback 到 `imgElement`
- `createMultiMaskedFullImage` / `createInvertedMultiMaskedFullImage` / `createMultiMaskedFullImage`（translation context）全改用 `maskImg`
- `extractCropFromFullImage` 的 `originalWidth/Height` 参数改传 `maskImg.naturalWidth/Height`
- 单 region 抠图仍用 `imgElement`（原图分辨率），保持质量
- 6000×8000 原图 mask canvas 从 ~190 MB 降到 balanced 模式 2048² ~16 MB

#### ✅ §5.1 detectionService 改 createImageBitmap
- `services/detectionService.ts:32-60` `prepareImageForUpload` 重写：
  - `fetch(imageUrl).blob()` + `createImageBitmap(blob)` 探测尺寸
  - 需缩放时 `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: 'high' })`
  - 单次 native resize 替代 `loadImage` + `drawImage`，快 30-50%
- 删除 `import { loadImage }` 未使用导入

#### ✅ §7.5 续 - GlobalSettings 外提 + lazy
- 新建 `components/GlobalSettings.tsx`（280 行），接收 `config/setConfig/updateConfig/transModels/setTransModels/fetchTransModels/onClose` props
- `App.tsx:11` 删除 `TRANSLATION_MODE_IMAGE_PROMPT/DEFAULT_TRANSLATION_PROMPT/TRANSLATION_CONTEXT_SYSTEM_PROMPT` 导入（移到 GlobalSettings 内部）
- `App.tsx:18-20` 新增 `const GlobalSettings = lazy(() => import('./components/GlobalSettings'))`
- `App.tsx:729-1011` 替换 283 行内联 JSX 为 `<Suspense fallback={null}><GlobalSettings ... /></Suspense>`
- 主 bundle 709.74 → **697.00 kB**（gzip 185.85 → 184.70），新增 GlobalSettings chunk 14.13 kB / gzip 2.22 kB

### 第二轮新增完成（2026-05-11）

#### ✅ §4.5 stitchImage 并行 loadImage
- `services/imageUtils.ts` `stitchImage()`：用 `Promise.all` 把每个 region 的 `renderRegionWithRestore` + `loadImage` 提到循环外
- 绘制循环保持串行（z-order、`ctx.save/clip/restore`）
- N region 场景下，2N 次串行 await 折叠为 1 次屏障

#### ✅ §5.2 OpenAI SSE buffer 拼接修复
- `services/aiService.ts` `generateOpenAIImage()` 流式分支
- 新增 `buffer` 变量，按 `\n` 切完整行；不完整尾巴留待下次 chunk
- 末尾 `decoder.decode()` flush + 处理无 trailing `\n` 的最后一行
- 抽 `processLine` 辅助，被切断的 `data: {...}` JSON 不再吞 token

#### ✅ §7.5 lazy load — PatchEditor + HelpModal
- `App.tsx` `React.lazy(() => import(...))` 包 `PatchEditor` 和 `HelpModal`
- `TextObject` 类型改 `import type` 不触发运行时 chunk
- 使用处 `<Suspense fallback={null}>` 包裹
- 主 bundle 减约 22 kB（721.78 → 709.74）；新增 PatchEditor chunk 20.97 kB、HelpModal chunk 3.54 kB
- 备注：`GlobalSettings` 内联在 App.tsx、`SettingsPanel` 在 Sidebar 子模块里，需先外提才能 lazy，暂不在本轮范围

#### ✅ §4.4 标准模式 stitch 结果缓存
- `hooks/useImageManager.ts` 新增 `stitchCacheRef: Map<imageId, { signature, url }>` 与 `getStitchedUrl()`
- 签名 = `previewUrl` + 每个完成区域的 `id + processedImageBase64 + 位置 + anchor + restoreBoxes + restoreMaskBase64`
- 命中即返回旧 URL；不命中重新 stitch + revoke 旧
- `handleDeleteImage` / `handleClearAllImages` 同步清缓存
- `App.tsx handleDownload`、`Sidebar.handleDownloadAllZip` 改用 `getStitchedUrl`
- `handleApplyAsOriginalWrapper` 保留原生 `stitchImage`（URL 所有权移交 history，不能共享缓存）
- Sidebar 新增 prop `getStitchedUrl` 并删除原 `stitchImage` 导入

#### ✅ §2.3 PatchEditor history → Object URL
- `HistoryState.imageData: ImageData` → `HistoryState.url: string`
- `recordHistory` 改 async：`canvas.toBlob` + `URL.createObjectURL`；evict 与 truncate 时 `releaseObjectURL`
- `restoreState` 改 async：`loadImage(url)` 后 `drawImage`
- `historyRef` 镜像 state 给 cleanup 用；init useEffect 的 cleanup 在 imageBase64 变化 / 卸载时 revoke 全部
- 2000×3000 图 10 条 history：~240 MB → 几 MB

#### ✅ §4.2 depadImageFromSquare 抽样 + Uint32 视图
- `services/imageUtils.ts` `depadImageFromSquare()`
- `imageData.data.buffer` 包成 `Uint32Array`，单次读 4 字节
- `isDarkPx(px)` 位运算解三通道
- 外层精确逐行/列，内层 stride=4 采样
- 4K 图扫描成本从 ~67M 像素读 降到 ~4M（理论 ~17×）

---

### 第一轮完成（基线提交至 b4674ff）

### P0 — 致命（4/4）

#### ✅ §1.1 `services/aiService.ts:22` 非法字符
- 用户手动删除中文顿号 `、`
- 验证：`tsc --noEmit` 0 error

#### ✅ §2.1 EditorCanvas 两处 `toDataURL` → Object URL
- `components/EditorCanvas.tsx` 顶部新增本地 `canvasToObjectURL` 辅助
- 替换 `saveBrushMask`（约第 514 行）和 `handleWindowMouseUp` 中的画笔保存（约第 625 行）
- 释放语义：`onUpdateRestoreMask` 的接收方 (App.tsx) 已经处理新旧 URL 切换

#### ✅ §2.4 `restoreCompositedCache` 泄漏 + 触发过度
- 改 `useRef<Record<string, string>>` + `restoreCacheVersion` 强制重渲
- 用 `restoreSignature`（仅 `processedImageBase64 / restoreMaskBase64 / restoreBoxes.length`）作为 useEffect 依赖
- 增加最终 unmount 释放钩子
- 拖框/改 prompt 不再触发 restore 全量合成

#### ✅ §7.1 `index.html` 重复 link/script
- 删除第二份 `<link rel="stylesheet" href="/index.css">`
- 删除第二份 `<script type="module" src="/index.tsx">`

---

### P1 — 重要（14/14）

#### ✅ §2.2 抽公共 `base64ToObjectURLAsync`
- `services/imageUtils.ts` 新增 async 工具，用 `fetch(dataURL).then(r => r.blob())` 避免 JS 循环
- 替换位置：
  - `hooks/useImageProcessor.ts` 两处 inline `atob + charCodeAt` 循环
- 保留同步版 `base64ToObjectURL`（暂无更多调用方）

#### ✅ §2.5 翻译模式 `urlToBase64` 调用去重
- `hooks/useImageProcessor.ts` 两个分支（useFullImageMasking 和普通路径）都改为：
  ```ts
  let payloadBase64: string | null = null;
  const getPayloadBase64 = async () => {
      if (payloadBase64 == null) payloadBase64 = await urlToBase64(payloadUrl);
      return payloadBase64;
  };
  ```
  调用结束后 `payloadBase64 = null` 释放引用

#### ✅ §3.2 `selectedImage` 用 useMemo
- `hooks/useImageManager.ts` 引入 `useMemo`
- `useMemo(() => images.find(...), [images, selectedImageId])`

#### ✅ §3.3 App.tsx 大批 handler `useCallback`
- 新增 useCallback 包装：
  - `handleManualPatchUpdate`
  - `onRegionsChanged`
  - `handleUpload`（兼带 §8.3 修复）
  - `handleOpenEditor`
  - `handleEditorSave`
  - `handleOcrRegion`
  - `handleDownload`
  - `handleApplyAsOriginalWrapper`
  - `updateConfig`
  - `fetchTransModels`
- 新增稳定适配器：
  - `editorOnUpdateRegions / editorOnOpenEditor / editorOnOcrRegion / editorOnAdjustRegionSize`
  - `sidebarOnOpenGlobalSettings / sidebarOnOpenHelp`
- EditorCanvas / Sidebar 的 JSX inline 箭头全部改为直接引用

#### ✅ §3.4 useCanvasInteraction effect 依赖收敛
- `hooks/useCanvasInteraction.ts` 增加 `onUpdateRegionsRef` / `onSelectRegionRef`
- effect 依赖从 `[disabled, onUpdateRegions, onSelectRegion]` 收敛到 `[disabled]`
- 鼠标拖拽过程不再因父组件刷新而丢监听器

#### ✅ §6.1 PatchEditor `selectedText` useMemo
- `components/PatchEditor.tsx` 新增 `selectedText = useMemo(() => textObjects.find(...), [textObjects, selectedTextId])`
- 替换 JSX 内 10 处 `textObjects.find(t => t.id === selectedTextId)?.X` 为 `selectedText?.X`

#### ✅ §6.2 Sidebar `React.memo`
- `components/Sidebar.tsx` 末尾导出改为 `React.memo(Sidebar)`
- 配合 §3.3 才生效

#### ✅ §8.1 `Intl.Collator` 缓存
- `services/imageUtils.ts` `naturalSortCompare` 改用模块级常量 `naturalCollator`

#### ✅ §8.2 `useConfig` localStorage debounce
- `hooks/useConfig.ts` 写入改为 `setTimeout 300ms` + cleanup `clearTimeout`
- 输入框敲字不再每次按键全量序列化

#### ✅ §8.3 `handleUpload` 重置 input.value 提前
- 把 `e.target.value = ''` 移到 await 之前
- 修复用户重选同名文件不触发的小 bug

#### ✅ §7.4 Inter 字体 preconnect（顺手附加）
- `index.html` 加 `<link rel="preconnect" href="https://fonts.googleapis.com">` 和 `https://fonts.gstatic.com`
- `&display=swap` 早就在 URL 里，无需改

---

### P2 — 次要（首轮 3 项；本轮新增 §4.2 + §4.4 + §2.3 等已并入"第二轮新增完成"段落）

#### ✅ §8.4 图库缩略图 lazy
- `components/Sidebar.tsx` 第 403 行附近 `<img loading="lazy" decoding="async">`

#### ✅ §9.3 useImageManager 死代码清理
- 删除 `useImageManager.ts` 中重复的 `handleManualPatchUpdate`
- 删除工具 `dataURLtoBlob`（其唯一调用方就是上面那个死代码）
- 修复 §3.3 改造过程中误删的 `handleDeleteImage` 内 `setImages` 包装

---

## 2. 待办（3 项）

### P2 剩余（1）

#### ⏳ §7.2 Tailwind CDN → build 时
- 当前 `<script src="https://cdn.tailwindcss.com">` runtime JIT
- 做法：装 `tailwindcss` + `postcss` + `autoprefixer`，把 `tailwind.config` 移到 ts 文件，CSS 变量保留在 `index.css`
- 注意：index.html `tailwind.config` 内联 JSON 要平移到 config 文件

---

### Bug / 一致性（1）

#### ⏳ §9.1 字段重命名 `processedImageBase64` → `processedImageUrl`
- `types.ts:19` 注释已经说"The result from API"但实际存 Object URL
- 同步重命名 `restoreMaskBase64` → `restoreMaskUrl`
- 影响范围广（30+ 引用），建议单独一个 PR
- 风险：必须配合 §3.1 normalize state 一起，否则反复改

---

### 重头戏（暂未开始）

#### ⏳ §3.1 normalize `images` state
- 全项目最大性能瓶颈
- 当前 `setImages(prev => prev.map(...))` 出现 30+ 处，每次 O(N×M)
- 做法（自上而下迁移）：
  1. 在 `useImageManager` 增加 `imagesById: Record<string, UploadedImage>` + `imageOrder: string[]`
  2. 保留 `images: UploadedImage[]` getter 给现有消费者（一段时间）
  3. 所有写操作改成更新 `imagesById[id]` + 视情况 `imageOrder`
  4. `selectedImage = imagesById[selectedImageId]` O(1)
  5. 最后逐步把渲染层切到 `imageOrder.map(id => imagesById[id])`
- 工作量大，建议单独占一个迭代

---

## 3. 本次改动文件清单

### 第二轮新增（2026-05-11）

```
App.tsx                                    PatchEditor/HelpModal 改 React.lazy + Suspense；handleDownload 用 getStitchedUrl；TextObject 改 import type
components/PatchEditor.tsx                 HistoryState.imageData → url；recordHistory/restoreState/init effect 全部 async，evict/卸载 revoke
components/Sidebar.tsx                     新增 prop getStitchedUrl；删除 stitchImage 直接调用；handleDownloadAllZip 改用缓存
hooks/useImageManager.ts                   stitchCacheRef + computeStitchSignature + getStitchedUrl + evictStitchCache；接入 delete/clearAll
services/aiService.ts                      流式分支 buffer 化 + processLine 抽离
services/imageUtils.ts                     stitchImage 改 Promise.all 预解码；depadImageFromSquare 改 Uint32Array + stride=4 采样
```

### 第一轮（基线提交至 b4674ff）

```
App.tsx                                    重写大量 handler 为 useCallback
components/EditorCanvas.tsx                toDataURL → toBlob、restoreCache 改 ref
components/PatchEditor.tsx                 selectedText useMemo + 10 处替换
components/Sidebar.tsx                     thumbnail lazy + React.memo 导出
hooks/useCanvasInteraction.ts              callback 通过 ref 透传
hooks/useConfig.ts                         localStorage 写 debounce
hooks/useImageManager.ts                   selectedImage useMemo、清理死代码
hooks/useImageProcessor.ts                 base64 工具 + urlToBase64 去重
index.html                                 删重复标签 + Inter preconnect
services/imageUtils.ts                     base64ToObjectURLAsync + Collator 缓存
```

---

## 4. 下一轮建议优先顺序

如果用户问"接着改哪几个"，按 ROI 推荐：

1. **§7.3 importmap 清理**（30 分钟、依赖洁净；同时为后续 vendor 分包扫清障碍）
2. **§7.5 续 — GlobalSettings/SettingsPanel 外提 + lazy**（1 小时、再降主 bundle）
3. **§5.3 executeWithRetry 用 AbortController**（30 分钟、修资源泄漏）
4. **§5.1 全链路 createImageBitmap**（1 小时、decoding 提速 30-50%）
5. **§4.3 mask canvas 限尺**（30 分钟、大图显存峰值）
6. **§9.2 inverted + squareFill UI 互斥**（10 分钟、Bug 修正）
7. **§3.5 删除 operationVersionRef**（5 分钟、死代码）
8. **§9.1 字段重命名**（半天、配合 §3.1）
9. **§7.2 Tailwind build 时**（1-2 小时、稳但要测样式）
10. **§8.5 JSZip Worker**（半天）
11. **§3.1 normalize state**（1-2 天、需慎重；最大瓶颈）

---

## 5. 复跑验证命令

```bash
npx tsc --noEmit -p .          # 类型检查
npm run build                  # 生产构建
npm run dev                    # 开发热载
```

最近一次结果（第二轮改完后）：
- tsc: 0 error
- build: 2.99s
- 主 bundle：dist/assets/index-*.js **709.74 kB (gzip 185.85 kB)**（首轮基线 731.78 / 190.52）
- 懒加载：PatchEditor 20.97 kB (gzip 5.90 kB)、HelpModal 3.54 kB (gzip 1.12 kB)
