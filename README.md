# BananaChange · AI 图像修补 Pro

> 浏览器里的漫画汉化工作台：**框选 → AI 重绘（或手动搬运）→ 嵌字 → 批量导出**。
> 支持 Gemini 与任意 OpenAI 兼容生图接口；可选 Python 后端提供气泡检测（RT-DETR）、文字擦除与字体服务。

前端是纯本地运行的 React 应用（图片不上传到除你自己配置的 AI 接口以外的任何地方），后端是为了「自动检测气泡 / 高质量擦字」准备的本地服务。没有后端也能用：只用手动框选 + AI 重绘 或 手动修补工坊即可。

---

## 目录

- [功能总览](#功能总览)
- [三种工作流](#三种工作流)
- [快速开始](#快速开始)
- [后端 API](#后端-api)
- [检测模型与离线运行](#检测模型与离线运行)
- [目录结构](#目录结构)
- [快捷键](#快捷键)
- [关键开关速查](#关键开关速查)
- [数据与隐私](#数据与隐私)
- [致谢](#致谢)
- [免责声明](#免责声明)

---

## 功能总览

**图库与导入**
- 上传文件 / 上传整个文件夹 / 拖拽进窗口 / `Ctrl+V` 粘贴剪贴板截图
- 多图图库，缩略图切换、跳过、单张删除、清空（双击确认）、整库打包 ZIP 下载
- 每张图片独立的撤销 / 重做历史

**选区与提示词**
- 画布上拖框、移动、拉角缩放；`Delete` / `Backspace` 删除选中框；画布右下角缩放控件
- 全局提示词 + 每个框的独立提示词，按场景分成 **翻译 / 擦除 / 自定义** 三套槽，场景互不覆盖
- 选区状态徽标（等待中 / 处理中 / 已完成 / 失败）、重试次数与错误历史

**生图链路**
- 服务提供商：Google Gemini（`@google/genai`）或 OpenAI 兼容接口（Chat Completions / Images Edits 两种形态）
- API 配置组（地址 / 密钥 / 模型三元组）一键切换、模型列表拉取
- 并发 / 串行执行、并发数、超时、每区域重试次数

**发送前的图像预处理**
- **正方形补全**：补成 1:1（模糊背景填充）再发，返回结果按原比例裁回，避免模型把画面拉扁
- **全图遮罩模式**：整页发一次（非选区涂白），更省调用、上下文更完整
- **反向遮罩模式**：选区涂白让 AI 重画背景，合成时保留原选区内容（与正方形补全互斥）
- **WebP 压缩发送**：像素尺寸不变、只降体积，省 token
- 发送记录（Payload Inspector）：最近 12 次真正发出去的图长什么样

**翻译与嵌字**
- 独立的翻译阶段：先「翻译当前图片 / 翻译所有图片」，译文缓存后随重绘提示词一起发送
- 术语表（跨图译名一致）、字体自动识别、自动取色（实测原文墨色）

**结果与导出**
- 结果页、框选还原 / 涂抹还原、应用为原图（覆盖）继续迭代、下载最终结果 / 打包 ZIP
- 工作状态整包导出导入（ZIP），配置备份导出导入（JSON）

**编辑器（汉化流水线）**
- 一键擦除全部 / 气泡内 / 气泡外文字（纯前端泛洪填充，后端在线时质量更高）
- 自动嵌字：按框适配字号、横竖排、避头尾换行、整块文字旋转（−180°～180°）；字体按需由后端下载缓存
- 画笔修补、吸管取色、译文冻结 / 解冻 / 涂白兜底、整页 AI 翻译

**可选 Python 后端**
- 自动检测气泡与文字（RT-DETR，见[致谢](#致谢)）、区域文字擦除、字体缓存服务

**界面与持久化**
- 浅色 / 深色主题，中文 / English 双语
- 编辑会话持久化到浏览器 IndexedDB（刷新、标签页被休眠后仍可恢复）
- 面板折叠状态、画笔大小/颜色等偏好记忆

---

## 三种工作流

在左栏「工作流模式」中切换：

| 模式 | 出图方 | 适合 |
|---|---|---|
| **AI 重绘** | 你配置的生图接口 | 有可用 API、想批量出图的场景。框选后直接点「开始重绘」 |
| **手动修补工坊** | 外部 AI（网页版 Gemini、任意生图站） | 没有生图接口，或外部网站效果更好。工坊负责切片、补方、复制与回填（`Ctrl+V`） |
| **编辑器** | 不调用生图接口 | 漫画汉化流水线：擦字 → 翻译 → 自动嵌字，纯前端 + 可选后端 |

> 应用内左栏右上角的 **?** 按钮（使用手册 & 技巧）也有简单的说明。

---

## 快速开始

### 环境要求

- **Node.js 18+**（Vite 6）与 npm
- 可选：**Python 3.9+**（建议用 Anaconda 环境），用于自动检测气泡、后端擦字、字体下载（不装也能跑手动流程）

### 1. 前端

```bash
npm install
npm run dev        # http://localhost:3000
```

构建与预览：

```bash
npm run build
npm run preview
```

### 2. 可选：Python 后端

```bash
pip install -r server/requirements.txt
python server/app.py          # 监听 0.0.0.0:5001
```

Windows 也可以直接双击 `server/启动服务.bat`（会优先使用脚本里配置的 Anaconda Python，找不到则回退到 PATH 中的 `python`）。

启动后：

- 应用内 **全局设置 → 漫画与重绘 → Python 后端地址** 填 `http://localhost:5001`
- 打开**启用漫画模块**后，左栏会出现「漫画工具箱」（自动检测气泡、AI 重绘区域、高级参数）
- 后端不在线时，擦除会自动回退到浏览器内置算法，其他功能不受影响

### 3. 环境变量（可选）

在项目根目录创建 `.env`：

```ini
GEMINI_API_KEY=your_key_here
```

`vite.config.ts` 会把它注入为 `process.env.API_KEY` / `process.env.GEMINI_API_KEY`，作为 Gemini 密钥的默认值（也可以在应用里直接填写并保存）。

> 多数情况下不需要 `.env`：在右侧「连接设置」里填 Base URL / Key / Model 即可，配置会保存在浏览器本地。

---

## 后端 API

统一服务入口 `server/app.py`，默认端口 **5001**（`MAX_CONTENT_LENGTH` 16 MB，全部接口都支持 `multipart/form-data` 上传或 JSON base64）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 健康检查：设备（cuda/cpu）、模型名、模型是否已加载 |
| `/detect` | POST | RT-DETR 文本 / 气泡检测。返回 `bubble` / `text_bubble` / `text_free` 三类框及置信度，可传 `conf_threshold`、`filter_classes` |
| `/erase` | POST | 区域文字擦除（flood fill 洞检测 + OpenCV inpaint）。`kind=bubble\|free`、`dilate`、`inpaint_radius`；返回 PNG，并在响应头回传实测取色 `X-Text-Color` / `X-Bg-Color` / `X-Text-Ratio` |
| `/fonts` | GET | 编辑器可用字体列表（含是否已缓存到 `server/fonts/`） |
| `/fonts/<id>` | GET | 字体文件本体，首次请求时由后端下载并缓存，之后直接读本地 |

模型在服务启动时预加载；加载失败不会缓存失败状态，首次 `/detect` 会自动重试。

---

## 检测模型与离线运行

气泡检测使用 Hugging Face 上的社区模型 **`ogkalu/comic-text-and-bubble-detector`**（RT-DETR-v2），权重缓存在：

```
server/model/
└─ models--ogkalu--comic-text-and-bubble-detector/     # 标准 HuggingFace 缓存布局
   ├─ blobs/                                            # 权重与配置实体（model.safetensors ≈ 163 MB）
   ├─ refs/main
   └─ snapshots/<commit>/                               # config.json / model.safetensors / preprocessor_config.json
```

- 首次启动后端时，`transformers` 会按需从 Hugging Face 下载到该目录（约 163 MB 权重）。
- 想**离线部署**：把已下载好的整个 `server/model/` 目录拷贝到目标机器即可，无需联网。
- 推理代码见 `server/inference_rtdetr.py`（`RTDetrForObjectDetection` + `RTDetrImageProcessor`，自动选择 cuda / mps / cpu）。

---

## 目录结构

```
bananaChange/
├─ App.tsx                   应用主壳：图库、画布、视图切换、快捷键、导出
├─ index.tsx / index.html    前端入口
├─ index.css                 Tailwind 主题（skin-* 变量、浅色/深色）
├─ types.ts                  Region / UploadedImage / AppConfig 等核心类型
├─ components/
│  ├─ Sidebar.tsx            左栏：图库、工作流模式、正方形补全、漫画工具箱
│  ├─ WorkflowDock.tsx       右侧停靠栏：提示词 / 连接设置 / 处理选项 / 执行
│  ├─ EditorCanvas.tsx       画布：框选、拖动缩放、状态徽标、缩放控件
│  ├─ EditorDock.tsx         编辑器属性面板（文字 / 画笔）
│  ├─ GlobalSettings.tsx     全局设置：常规 / 漫画与重绘 / 翻译 / 数据管理
│  ├─ PayloadInspector.tsx   发送记录查看器
│  ├─ HelpModal.tsx          使用手册 & 技巧
│  └─ sidebar/               侧栏子组件（设置面板、工坊条目、帮助提示、API 配置组…）
├─ hooks/
│  ├─ useConfig.ts           配置默认值、localStorage 读写与旧配置迁移
│  ├─ useImageManager.ts     图库增删、历史（撤销/重做）、应用为原图
│  ├─ useImageProcessor.ts   重绘主流程：切片 → 遮罩 → 补方 → 调用 → 回填
│  ├─ useCanvasInteraction.ts 画布框选与拖拽交互
│  └─ useMangaEditor.ts      编辑器：擦除、嵌字、画笔、翻译
├─ services/
│  ├─ aiService.ts / geminiService.ts   生图与翻译接口调用、重试
│  ├─ imageUtils.ts          裁切、遮罩合成、补方 / 裁回、编解码
│  ├─ textErase.ts / textLayout.ts      纯前端擦字算法、排版（避头尾/竖排）
│  ├─ detectionService.ts / fontService.ts  后端检测与字体接口
│  ├─ editorTranslate.ts / glossary.ts / translationCache.ts  整页翻译、术语表、译文缓存
│  ├─ sessionStore.ts        会话持久化（IndexedDB）
│  ├─ workbenchCopy.ts       工坊剪贴板（图文/纯文本，多级降级）
│  ├─ payloadLog.ts          发送记录
│  ├─ configTransfer.ts / workStateTransfer.ts / downloadZip.ts  配置与工作状态备份、打包导出
│  ├─ concurrencyUtils.ts / rateLimitGate.ts  并发与限流
│  └─ translations.ts        中英文案（含使用手册内容）
└─ server/                   Python 后端：app.py（Flask）、erase.py、inference_rtdetr.py
   ├─ model/                 检测模型缓存（见上一节）
   ├─ fonts/                 字体缓存（按需下载）
   ├─ requirements.txt
   └─ 启动服务.bat
```

---

## 快捷键

| 按键 | 作用 |
|---|---|
| `↑` `↓` `←` `→` | 上一张 / 下一张图片 |
| `Ctrl+V` | 粘贴剪贴板图片；在工坊的「回填区」粘贴 AI 结果 |
| `Delete` / `Backspace` | 删除当前选中的框 |
| `Ctrl+滚轮` | 缩放画布；编辑器里光标悬停在选中的框上时 = 调字号 |
| `Esc` | 关闭使用手册 |

> 图片级撤销 / 重做没有快捷键，用画布左上角的两个圆形箭头按钮；编辑器内的擦除撤回是右栏的独立按钮。

---

## 关键开关速查

| 开关 | 位置 | 要解决的问题 |
|---|---|---|
| **正方形补全**（默认开） | 左栏「工作流模式」 | AI 返回图被拉成方形、比例失真 |
| **启用翻译模式** | 全局设置 → 翻译 | 先识译原文，重绘时把译文交给模型画字 |
| **重绘前先翻译 / 必须翻译** | 全局设置 → 翻译 | 两阶段解耦，或回退到旧版一步到位 |
| **使用全图遮罩模式** | 全局设置 → 漫画与重绘 | 减少 API 调用次数、提供整页上下文 |
| **反向遮罩模式** | 全局设置 → 漫画与重绘 | 保留主体、只重画背景（与补方互斥） |
| **压缩发送给 AI 的图片** | 全局设置 → 漫画与重绘 | 省 token、加快上传 |
| **性能模式** | 全局设置 → 常规 | 大图库预览占内存 / 切图卡顿（只影响预览） |
| **会话持久化** | 全局设置 → 常规 | 刷新或标签页休眠后不丢失编辑现场 |
| **显示重试诊断** | 右侧「处理选项」 | 排查频繁失败的图片 |

---

## 数据与隐私

- 图片、选区、翻译与配置默认全部留在本机（`localStorage` + `IndexedDB`），只有调用 AI 接口时才发送裁剪 / 遮罩后的图片。
- **配置备份**（JSON）与**工作状态导出**（ZIP）内含 **明文密钥**，请自行妥善保管。
- 发送记录只保留最近 12 次、纯内存、刷新即清空。

---

## 致谢

### 检测模型（本项目依赖的核心开源模型）

- **[ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector)** — 本项目「自动检测气泡 / 文字」功能的检测模型。
  - 架构：**RT-DETR-v2**（通过 Hugging Face `transformers` 的 `RTDetrForObjectDetection` / `RTDetrImageProcessor` 加载）
  - 输出类别：`bubble`（气泡）、`text_bubble`（气泡内文字）、`text_free`（气泡外文字）
  - 训练数据：约 11k 张漫画图像（日漫 / 韩漫 / 美漫）
  - 作者与同源项目：[ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate)
  - 模型权重与版权归原作者所有，使用 / 再分发请遵循模型主页标注的许可条款。**没有这个模型，本项目的自动气泡检测能力无从谈起 —— 在此向作者致以诚挚感谢。**

### 其他开源项目

- 后端：**PyTorch**、**Hugging Face Transformers**、**OpenCV**、**NumPy**、**Pillow**、**Flask** + **Flask-CORS**
- 前端：**React 19**、**TypeScript**、**Vite**、**Tailwind CSS 4**
- 其他库：**JSZip**（打包导出）、**@google/genai**（Gemini 接口）
- 感谢 RT-DETR 原作者与 Hugging Face 社区在目标检测模型与权重分发上的贡献。

---

## 免责声明

- 本项目仅供个人学习、研究与**合法素材**的处理（例如你拥有版权或已获授权的漫画、插画）。
- 使用 AI 接口产生的费用、内容与版权合规责任由使用者自行承担；请遵守所用接口提供商的服务条款。
- 请勿用于侵犯他人著作权、传播违法内容的用途。

## 许可证

本仓库当前未附带开源许可证文件；如需二次分发，请先与仓库作者确认，并同时遵守上述第三方模型与库各自的许可条款。
