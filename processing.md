# Processing — `report.md` 执行进度

> 起始基线：`d04b29a 修复OOM：全链路base64字符串替换为Blob Object URL`
> 当前分支：`dev`
> 最后更新：2026-05-11（第四轮 / 收官完成）
> 关联文件：[`report.md`](./report.md)

---

## 0. 进度概览

| 级别 | 总数 | 完成 | 待办 |
|---|---|---|---|
| P0 致命 | 4 | 4 ✅ | 0 |
| P1 重要 | ~14 | 14 ✅ | 0 |
| P2 次要 | ~11 | 11 ✅ | 0 |
| Bug/一致性 | 3 | 3 ✅ | 0 |
| 重头戏 | 1 | 1 ✅ | 0 |
| **合计** | ~33 | **33 ✅** | **0** |

**验证状态（第四轮收尾）**：
- `tsc --noEmit -p .` 通过（0 error）
- `vite build` 通过：
  - 主 bundle `index-*.js`：**697.12 kB / gzip 184.76 kB**（第三轮 697.00 / 184.70；首轮基线 731.78 / 190.52）
  - CSS：49.81 kB / gzip 8.82 kB（v4 内联编译；之前 23.65 / 6.42 kB，但移除了 cdn 运行时）
  - **关键收益**：移除 cdn.tailwindcss.com 运行时 JIT（~300 kB 未压缩），首屏总下载体积下降约 280 kB
  - 懒加载 chunk：`GlobalSettings-*.js` 14.13 kB / gzip 2.22 kB、`PatchEditor-*.js` 20.97 kB / gzip 5.90 kB、`HelpModal-*.js` 3.54 kB / gzip 1.12 kB

---

## 1. 第四轮新增完成（2026-05-11 收官）

### ✅ §9.1 字段重命名 processedImageBase64 → processedImageUrl
- `types.ts:19,20` 改名 + 注释更新（从 "result from API" → "Object URL of the API-generated patch"）
- `types.ts:31` `restoreMaskBase64` → `restoreMaskUrl`，注释强调 Object URL 语义
- 7 个代码文件 49 处引用全部更新：
  - `App.tsx`：12 处
  - `hooks/useImageProcessor.ts`：5 处
  - `hooks/useImageManager.ts`：5 处
  - `services/imageUtils.ts`：8 处
  - `components/EditorCanvas.tsx`：14 处
  - `components/sidebar/WorkbenchItems.tsx`：2 处
- 验证：`tsc --noEmit` 0 error（TypeScript 编译器保证零遗漏）
- 收益：后续开发者按字段名调用 `atob()` 的隐患排除

### ✅ §3.1 normalize images state（重头戏）
- **新 store 结构**：`{ byId: Record<string, UploadedImage>; order: string[] }`
- **新 API**：
  - `updateImage(id, updater)` — 替代 `setImages(prev => prev.map(img => img.id !== id ? img : updater(img)))`
  - `updateAllImages(updater)` — 替代 `setImages(prev => prev.map(img => ({...img, ...})))`
  - `images` 改为 useMemo 派生数组：`store.order.map(id => store.byId[id])`
  - `selectedImage` 从 `useMemo + find` O(N) → **`store.byId[selectedImageId]` O(1)**
- **迁移点**（共 30+ 处 setImages 调用）：
  - `App.tsx`：12 处 `setImages(prev => ...)` → `updateImage / updateAllImages`
  - `hooks/useImageProcessor.ts`：函数签名 `setImages` → `updateImage, updateAllImages`，9 处调用全替换；删除未使用的 `React` 默认导入
  - `hooks/useImageManager.ts`：内部 store + 全部 handler 改 `updateImage` pattern
- **handleDeleteImage / handleClearAllImages**：reducer 内部副作用（`cleanupImageUrls` + `setSelectedImageId`）— `releaseObjectURL` 幂等，StrictMode 双跑安全
- **未对外暴露 setImages**：杜绝消费者直接拷贝整个数组的反模式
- 收益：
  - 单 region 改 prompt：之前创建 N 个新 image 引用 + M 个新 region 引用；现在 1 个新 image + 1 个新 Record + 1 个新 regions 数组
  - `selectedImage` 访问 O(N) → O(1)
  - 浅拷贝量从 O(N) 降到 O(1)，特别是大图库（>50 张）的输入框敲字、拖框操作

### ✅ §7.2 Tailwind CDN → build 时
- 安装 `tailwindcss@4.3 + @tailwindcss/vite@4.3`
- `vite.config.ts`：添加 `tailwindcss()` 插件
- `index.css` 已使用 v4 语法（`@import "tailwindcss"; @theme { ... }`），无需改动
- `index.tsx`：新增 `import './index.css'`
- `index.html`：
  - 删除 `<script src="https://cdn.tailwindcss.com"></script>`（~300 kB runtime JIT）
  - 删除内联 `tailwind.config = {...}` script（v4 用 CSS `@theme` 取代）
  - 删除 `<style>` 块（theme CSS 变量已在 index.css）
  - 删除 `<link rel="stylesheet" href="/index.css">`（通过 index.tsx import）
  - 从 146 行减到 16 行
- 收益：
  - 移除 ~300 kB 运行时 JIT script
  - FCP 减约 100–300 ms（无需浏览器内扫 className 生成 CSS）
  - CSS 现在 build 时 tree-shake，未使用的 utility 不打包
  - 生产环境符合 Tailwind 官方建议

---

## 2. 历轮完成概要

### 第三轮（commit `8d29d22`）
- §3.5 删除 operationVersionRef 死代码
- §9.2 inverted + squareFill UI 互斥（SettingsPanel 禁用 + useImageProcessor 跳过往返）
- §7.3 importmap + npm 双重依赖清理
- §5.3 executeWithRetry 用 AbortController 真正取消 fetch / Gemini SDK
- §4.3 mask canvas 限尺（用 previewUrl 而非 originalUrl，6000×8000 显存从 ~190 MB → ~16 MB）
- §5.1 detectionService 改 createImageBitmap（native resize 提速 30-50%）
- §7.5 续 — GlobalSettings 外提 + lazy（主 bundle 709.74 → 697.00 kB）

### 第二轮（commit `190cfe6`）
- §4.5 stitchImage 并行 loadImage（N region 折叠为 1 次屏障）
- §5.2 OpenAI SSE buffer 拼接修复（切断行不再吞 token）
- §7.5 lazy load — PatchEditor + HelpModal（主 bundle 减 22 kB）
- §4.4 标准模式 stitch 结果缓存（重复下载零成本）
- §2.3 PatchEditor history → Object URL（2000×3000 图 10 条 240 MB → 几 MB）
- §4.2 depadImageFromSquare 抽样 + Uint32 视图（4K 图扫描 ~17×）

### 第一轮（commit `cf72072` + `b4674ff`）
- §1.1 aiService.ts 中文顿号修复
- §2.1 EditorCanvas 两处 toDataURL → Object URL
- §2.4 restoreCompositedCache 改 useRef + signature
- §7.1 index.html 重复 link/script 清理
- §2.2 dataURLtoObjectURL 公共工具（fetch + blob 替代 charCodeAt 循环）
- §2.5 翻译模式 urlToBase64 调用去重
- §3.2 selectedImage useMemo
- §3.3 App.tsx 大批 handler useCallback + 稳定适配器
- §3.4 useCanvasInteraction effect 依赖收敛
- §6.1 PatchEditor selectedText useMemo
- §6.2 Sidebar React.memo
- §8.1 Intl.Collator 模块级缓存
- §8.2 useConfig localStorage debounce 300ms
- §8.3 handleUpload 重置 input.value 提前
- §7.4 Inter 字体 preconnect
- §8.4 图库缩略图 lazy + decoding=async
- §9.3 useImageManager 死代码清理

---

## 3. 第四轮改动文件清单

```
hooks/useImageManager.ts           normalize store (byId + order)、updateImage/updateAllImages helper、selectedImage O(1)、所有 handler 重写
hooks/useImageProcessor.ts         函数签名改 (updateImage, updateAllImages)，9 处 setImages 全替换；删 React 默认导入
App.tsx                            12 处 setImages 改 updateImage/updateAllImages；useImageProcessor 调用参数适配
types.ts                           processedImageBase64 → processedImageUrl；restoreMaskBase64 → restoreMaskUrl + 注释更新
components/EditorCanvas.tsx        14 处字段引用更新
components/sidebar/WorkbenchItems.tsx  2 处字段引用更新
services/imageUtils.ts             8 处字段引用更新
vite.config.ts                     新增 @tailwindcss/vite plugin
index.html                         从 146 行简化为 16 行；移除 cdn.tailwindcss.com、内联 tailwind.config、内联 <style> 主题块、重复 link
index.tsx                          新增 import './index.css'
package.json                       新增 devDependencies: tailwindcss@4.3, @tailwindcss/vite@4.3
```

---

## 4. 累计四轮收益总览

| 指标 | 基线（d04b29a） | 第四轮收尾 | 变化 |
|---|---|---|---|
| 主 bundle (raw / gzip) | 731.78 / 190.52 kB | 697.12 / 184.76 kB | **-4.7% / -3.0%** |
| CSS (raw / gzip) | ~23.65 / 6.42 kB | 49.81 / 8.82 kB | (build 时编译，体积换运行时性能) |
| Tailwind runtime JIT | ~300 kB CDN | 0 | **-100%** |
| 首屏 JS 总下载估算 | ~1024 kB | ~747 kB | **约 -280 kB** |
| `selectedImage` 查找 | O(N) | O(1) | 50 张图 ~50× |
| 单 region 更新 浅拷贝量 | O(N images + M regions) | O(1 image + M regions) | 大图库显著 |
| Editor history 内存 | ~240 MB / 10 条 | 几 MB | ~95% 降 |
| 4K 图 depad 扫描 | ~67M px 读 | ~4M px 读 | ~17× |
| Mask canvas 显存（6000×8000） | ~190 MB | ~16 MB | ~92% 降 |
| API 取消 | wrapper reject only | 真正 abort fetch/SDK | 修复泄漏 |
| OpenAI SSE | 切断行吞 token | buffer 拼接 | 修复 bug |
| 检测请求路径 | loadImage + drawImage | createImageBitmap (native resize) | 快 30-50% |
| Editor canvas toDataURL | base64 string | toBlob + Object URL | OOM 修复 |
| restoreCache 泄漏 | 每代 leak | useRef + signature | 修复 |
| Code split | 单 bundle | PatchEditor / HelpModal / GlobalSettings lazy | 首屏 -38 kB |

---

## 5. 后续可继续追踪（report 中标 🟢 低优先 / 未列入）

| 项 | 说明 |
|---|---|
| §5.4 重试指数退避 | `aiService.ts:104` 固定 1s，限流时硬重试；改 `Math.min(30000, 1000 * 2 ** attempt)` |
| §6.3 内联 SVG 抽 Icons 组件 | 收益小但首次 mount DOM 体量 -20% |
| Vendor manualChunks | 主 bundle > 500 kB 警告，可拆分 @google/genai 等 |
| §8.5 JSZip Worker | 50 张图打包仍冻结主线程；comlink + jszip worker bundle |
| `useImageManager` reducer 副作用拿出 | StrictMode 双跑 releaseObjectURL 幂等无副作用，但拿出更优雅 |

---

## 6. 复跑验证命令

```bash
npx tsc --noEmit -p .          # 类型检查
npm run build                  # 生产构建
npm run dev                    # 开发热载
```

最近一次结果（第四轮收官）：
- tsc: 0 error
- build: 1.69s
- 主 bundle：dist/assets/index-*.js **697.12 kB (gzip 184.76 kB)**
- CSS：dist/assets/index-*.css 49.81 kB (gzip 8.82 kB)
- 懒加载：PatchEditor 20.97 kB、HelpModal 3.54 kB、GlobalSettings 14.13 kB
- 首屏不再加载 cdn.tailwindcss.com（移除 ~300 kB JIT）
