
import { Language } from "../types";

export const translations = {
  zh: {
    appTitle: "AI 图像修补 Pro",
    appSubtitle: "AI 局部重绘工具",
    
    // Upload
    uploadFiles: "上传文件",
    uploadFolder: "上传文件夹",
    dropToUpload: "松开鼠标即可上传图片",
    
    // Gallery
    galleryTitle: "图库",
    selectToEdit: "点击选择编辑",
    deleteImage: "删除图片",
    downloadZip: "下载压缩包",
    zipping: "压缩中...",
    skipImage: "跳过处理 (包含原图在Zip)",
    enableImage: "恢复处理",
    skipped: "已跳过",
    clearGallery: "清空图库",
    clearGalleryConfirm: "确定要清空所有图片吗？此操作无法撤销。",
    
    // Manga Toolkit
    mangaTitle: "漫画工具箱",
    detectBtn: "✨ 自动检测气泡",
    detecting: "检测中...",
    detectTip: "将调用后端 Python 接口检测文本气泡",
    detectApiLabel: "检测接口 (Python Backend)",
    ocrApiLabel: "OCR 接口 (Python Backend)",
    noBubblesFound: "未检测到气泡",
    bubblesFound: "检测到 {count} 个区域",
    detectScopeCurrent: "当前图片",
    detectScopeAll: "所有图片",
    detectAdvanced: "高级参数调整",
    detectInflation: "气泡膨胀率",
    detectOffset: "位置偏移 (X / Y)",
    detectConfidence: "置信度阈值",
    
    // OCR
    ocrBtn: "OCR 识别",
    ocrLoading: "识别中...",
    ocrSuccess: "识别结果",
    ocrFailed: "识别失败",
    ocrPlaceholder: "暂无文字",
    
    // Prompt
    promptTitle: "提示词",
    promptGlobalLabel: "全局默认提示词",
    promptSpecificLabel: "当前选中选区提示词", 
    promptFullImageLabel: "当前图片专用提示词 (全图模式)",
    promptPlaceholder: "描述你想要修改的内容 (例如: 去除水印, 换成蓝天)...",
    promptSpecificPlaceholder: "在此追加针对此区域的额外细节描述...", 
    promptFullImagePlaceholder: "在此覆盖针对此整张图片的专用描述...",
    
    // Settings
    settingsTitle: "连接设置",
    provider: "服务提供商",
    baseUrl: "接口地址 (Base URL)",
    apiKey: "API 密钥 (Key)",
    model: "模型名称",
    fetchList: "获取列表",
    fetching: "获取中...",
    customModel: "自定义...",
    modelIdPlaceholder: "输入模型 ID",
    
    // Workflow Modes
    modeTitle: "工作流模式",
    modeApi: "AI 自动生成",
    modeManual: "手动修补工坊",
    
    // Manual Workbench
    workbenchTitle: "补丁工坊",
    sourceCrop: "原始切片",
    patchZone: "回填区 (Ctrl+V)",
    copyCrop: "复制",
    copied: "已复制",
    pasteHint: "在此处粘贴处理后的图片",
    noRegions: "请先在图片上框选区域",
    
    // Patch Editor
    editor_title: "修补编辑器",
    editor_tool_brush: "画笔 (涂抹)",
    editor_tool_text: "文字 (嵌字)",
    editor_brush_size: "画笔大小",
    editor_brush_color: "画笔颜色",
    editor_brush_fill: "填充整块 (清空气泡)",
    editor_text_content: "文本内容",
    editor_text_size: "字号",
    editor_text_color: "颜色",
    editor_text_outline: "描边颜色",
    editor_text_outline_width: "描边宽度",
    editor_text_bg: "背景填充",
    editor_text_vertical: "竖排文字",
    editor_text_bold: "加粗",
    editor_btn_save: "保存修补",
    editor_btn_cancel: "取消",
    editor_btn_undo: "撤销",
    editor_btn_redo: "重做",
    editor_tip_drag: "拖拽移动文字",
    editor_zoom_in: "放大",
    editor_zoom_out: "缩小",
    editor_zoom_reset: "重置缩放",
    
    // Execution
    executionTitle: "处理选项",
    mode: "执行模式",
    modeConcurrent: "并发执行 (快)",
    modeSerial: "串行执行 (稳)",
    concurrency: "并发数量",
    timeoutLabel: "超时时间 (秒)",
    retriesLabel: "失败重试次数",
    processFullImage: "无选区时处理全图",
    processFullImageDesc: "如果图片没有框选区域，则自动发送整张图片。",
    
    // Preview
    previewTitle: "补丁预览",
    
    // Actions
    applyAll: "应用到所有 {count} 张图片",
    generate: "开始生成",
    generateAll: "批量生成所有",
    stop: "停止生成",
    stopping: "正在停止...",
    downloadResult: "下载最终结果",
    applyAsOriginal: "应用为原图 (覆盖)",
    undoImage: "撤销图片变更",
    redoImage: "重做图片变更",
    
    // Status
    idle: "空闲",
    cropping: "正在裁剪区域...",
    api_calling: "AI 正在思考...",
    translating: "AI 正在翻译上下文...",
    stitching: "正在合成图片...",
    done: "完成",
    stopped_by_user: "已由用户终止",
    
    // Badge Status
    status_pending: "等待中",
    status_processing: "处理中",
    status_completed: "已完成",
    status_failed: "失败",
    
    // Canvas
    readyToCreate: "准备开始",
    uploadHint: "通过左侧上传图片，或直接粘贴 (Ctrl+V)",
    
    // Global Settings
    globalSettings: "全局设置",
    enableMangaMode: "启用漫画模块",
    enableMangaModeDesc: "启用气泡检测、OCR 识别、手动涂抹嵌字等漫画汉化辅助功能",
    enableBubbleDetection: "启用气泡检测",
    enableBubbleDetectionDesc: "在侧边栏显示自动检测工具",
    enableOCR: "启用 OCR 识别",
    enableOCRDesc: "在选区上显示 OCR 文本识别按钮",
    enableManualEditor: "启用修补编辑器",
    enableManualEditorDesc: "启用画笔涂抹和文字嵌字工具",
    enableVerticalTextDefault: "默认竖排文字",
    enableVerticalTextDefaultDesc: "新建文本框时默认开启【竖排】选项",
    useFullImageMasking: "使用全图遮罩模式",
    useFullImageMaskingDesc: "发送除选区外全白的整张图片给 API，而非仅发送裁剪切片。这能提供更好的上下文，并大幅减少 API 调用次数。",
    useInvertedMasking: "反向遮罩模式 (重绘背景)",
    useInvertedMaskingDesc: "将选区涂白让 AI 填充背景，合成时保留原图选区内容。适用于保留主体、仅替换背景的场景。",
    fullImageOpaquePercent: "边缘融合不透明度 (%)",
    fullImageOpaquePercentDesc: "在从全图回填切片时，中心多少百分比的区域保持完全不透明。剩余的边缘部分将进行渐变羽化融合。",
    
    // Translation Mode
    enableTranslationMode: "启用翻译模式 (预处理)",
    enableTranslationModeDesc: "在重绘之前，先使用 LLM 识别并翻译图片中的文字，作为上下文发送给重绘模型。",
    translationSettings: "翻译模型设置 (OpenAI 兼容)",
    translationPromptLabel: "翻译系统提示词 (Prompt)",
    translationPromptPlaceholder: "例如: 翻译图片中的文本为中文，并保留位置描述...",
    reset: "重置",
    resetToDefault: "恢复默认提示词",
    close: "关闭",

    // --- HELP CONTENT ---
    helpTitle: "使用手册 & 技巧",
    
    // Tabs
    help_tab_basics: "🚀 快速上手",
    help_tab_manga: "📖 漫画工具",
    help_tab_pro: "⚡ 专业功能",
    help_tab_editor: "🎨 手动编辑",
    help_tab_tricks: "🧙‍♂️ 隐藏技巧",

    // Content - Basics
    help_basics_1_title: "1. 导入图片",
    help_basics_1_desc: "点击左侧上传按钮，或者直接将图片/文件夹拖入窗口。支持 Ctrl+V 粘贴剪贴板图片。",
    help_basics_2_title: "2. 框选区域",
    help_basics_2_desc: "在中间的画布上，按住鼠标左键拖动，框选你想要 AI 修改的区域（如水印、文字气泡）。",
    help_basics_3_title: "3. 配置提示词",
    help_basics_3_desc: "在左侧输入提示词。全局提示词对所有选区生效，也可以点击选区单独设置专用提示词。",
    help_basics_4_title: "4. 一键生成",
    help_basics_4_desc: "配置好 API Key 后，点击【开始生成】。勾选【应用到所有】可批量处理整个图库。",

    // Content - Manga
    help_manga_1_title: "自动气泡检测",
    help_manga_1_desc: "在【全局设置】开启漫画模块后，使用侧边栏的【自动检测】按钮，利用本地 Python 后端自动识别所有文本气泡，省去手动框选。",
    help_manga_2_title: "OCR 文本识别",
    help_manga_2_desc: "开启 OCR 后，每个选区上方会出现 OCR 按钮。点击可提取区域内的文字（需后端支持）。",
    help_manga_3_title: "翻译模式",
    help_manga_3_desc: "在重绘前，先让 AI 识别并翻译图片文字，将翻译结果作为“上下文”发给绘图模型，极大提高嵌字的准确性。",

    // Content - Pro
    help_pro_1_title: "全图遮罩模式 (省流神器)",
    help_pro_1_desc: "默认是每个选区发一次请求（N次）。开启此模式后，系统会将一张图上的所有选区合并，只发送一次全图请求（非选区部分涂白）。既省钱，又能让 AI 看到选区之间的关联。",
    help_pro_2_title: "应用为原图 (迭代编辑)",
    help_pro_2_desc: "生成满意后，点击【应用为原图】。当前的生成结果会变成新的“原图”，你可以再次框选修补其他细节，实现无限次迭代。",
    help_pro_3_title: "并发控制",
    help_pro_3_desc: "在【处理选项】中调整并发数。Gemini 免费版建议串行（1），付费版或 OpenAI 可根据配额调高并发。",

    // Content - Editor
    help_editor_1_title: "内置修补器",
    help_editor_1_desc: "在手动模式或完成生成后，点击选区上的【编辑】图标，进入全功能编辑器。",
    help_editor_2_title: "画笔与填充",
    help_editor_2_desc: "使用画笔涂抹去除杂物。点击【填充整块】可快速清空整个气泡背景。",
    help_editor_3_title: "排版嵌字",
    help_editor_3_desc: "添加文本框，支持横/竖排切换、描边、背景色和自动换行。滚轮可快速调整字号。",

    // Content - Tricks (Hidden)
    help_tricks_1_title: "⌨️ 键盘流操作",
    help_tricks_1_desc: "使用方向键 (↑ ↓ ← →) 快速切换上一张/下一张图片。Ctrl+Z / Ctrl+Y 可在编辑器中撤销/重做。",
    help_tricks_2_title: "🖱️ 鼠标滚轮妙用",
    help_tricks_2_desc: "在编辑器中：Ctrl+滚轮 = 缩放画布；光标悬停在文本框上 + 滚轮 = 快速调整字号。",
    help_tricks_3_title: "🛡️ 防误删机制",
    help_tricks_3_desc: "底部的【清空图库】按钮需要“双击”才会执行，防止手滑清空列表。",
    help_tricks_4_title: "📂 文件夹批量导入",
    help_tricks_4_desc: "上传按钮旁边的文件夹图标，支持一次性导入整个目录的数百张图片。",
  },
  en: {
    appTitle: "GenAI Patcher Pro",
    appSubtitle: "AI Inpainting Tool",
    
    // Upload
    uploadFiles: "Files",
    uploadFolder: "Folder",
    dropToUpload: "Release to upload images",
    
    // Gallery
    galleryTitle: "Gallery",
    selectToEdit: "Select to edit",
    deleteImage: "Delete image",
    downloadZip: "Download Zip",
    zipping: "Zipping...",
    skipImage: "Skip processing (Include original in Zip)",
    enableImage: "Enable processing",
    skipped: "SKIPPED",
    clearGallery: "Clear Gallery",
    clearGalleryConfirm: "Are you sure? This cannot be undone.",
    
    // Manga Toolkit
    mangaTitle: "Manga Toolkit",
    detectBtn: "✨ Auto Detect Bubbles",
    detecting: "Detecting...",
    detectTip: "Uses Python backend to detect text bubbles",
    detectApiLabel: "Detection API (Python Backend)",
    ocrApiLabel: "OCR API (Python Backend)",
    noBubblesFound: "No bubbles found",
    bubblesFound: "Found {count} regions",
    detectScopeCurrent: "Current Image",
    detectScopeAll: "All Images",
    detectAdvanced: "Tuning Parameters",
    detectInflation: "Inflation Rate",
    detectOffset: "Position Offset (X / Y)",
    detectConfidence: "Confidence Threshold",
    
    // OCR
    ocrBtn: "OCR",
    ocrLoading: "OCR...",
    ocrSuccess: "OCR Result",
    ocrFailed: "OCR Failed",
    ocrPlaceholder: "No text",
    
    // Prompt
    promptTitle: "Prompt",
    promptGlobalLabel: "Global Default Prompt",
    promptSpecificLabel: "Current Region Prompt", 
    promptFullImageLabel: "Full Image Specific Prompt",
    promptPlaceholder: "Describe the edit...",
    promptSpecificPlaceholder: "Append specific details for this region...", 
    promptFullImagePlaceholder: "Override details for this specific image...",
    
    // Settings
    settingsTitle: "Connection Settings",
    provider: "Provider",
    baseUrl: "Base URL",
    apiKey: "API Key",
    model: "Model",
    fetchList: "Fetch List",
    fetching: "Fetching...",
    customModel: "Custom...",
    modelIdPlaceholder: "Model ID",
    
    // Workflow Modes
    modeTitle: "Workflow Mode",
    modeApi: "AI Generation",
    modeManual: "Patch Workbench",
    
    // Manual Workbench
    workbenchTitle: "Patch Workbench",
    sourceCrop: "Source Crop",
    patchZone: "Drop Zone (Ctrl+V)",
    copyCrop: "Copy",
    copied: "Copied",
    pasteHint: "Paste processed image here",
    noRegions: "Draw regions on canvas first",
    
    // Patch Editor
    editor_title: "Patch Editor",
    editor_tool_brush: "Brush (Erase)",
    editor_tool_text: "Text (Typeset)",
    editor_brush_size: "Size",
    editor_brush_color: "Color",
    editor_brush_fill: "Fill All (Clean Bubble)",
    editor_text_content: "Content",
    editor_text_size: "Size",
    editor_text_color: "Color",
    editor_text_outline: "Outline Color",
    editor_text_outline_width: "Outline Width",
    editor_text_bg: "Background",
    editor_text_vertical: "Vertical Text",
    editor_text_bold: "Bold",
    editor_btn_save: "Save Patch",
    editor_btn_cancel: "Cancel",
    editor_btn_undo: "Undo",
    editor_btn_redo: "Redo",
    editor_tip_drag: "Drag text to move",
    editor_zoom_in: "Zoom In",
    editor_zoom_out: "Zoom Out",
    editor_zoom_reset: "Reset Zoom",
    
    // Execution
    executionTitle: "Processing Options",
    mode: "Mode",
    modeConcurrent: "Concurrent",
    modeSerial: "Serial",
    concurrency: "Concurrency Limit",
    timeoutLabel: "Timeout (Seconds)",
    retriesLabel: "Max Retries",
    processFullImage: "Process Full Image if Empty",
    processFullImageDesc: "If no regions are selected, the entire image will be sent to AI.",
    
    // Preview
    previewTitle: "Patch Previews",
    
    // Actions
    applyAll: "Apply to all {count} images",
    generate: "Generate Patches",
    generateAll: "Generate All Patches",
    stop: "Stop",
    stopping: "Stopping...",
    downloadResult: "Download Result",
    applyAsOriginal: "Apply as Original",
    undoImage: "Undo Image Change",
    redoImage: "Redo Image Change",
    
    // Status
    idle: "Idle",
    cropping: "Cropping regions...",
    api_calling: "AI is processing...",
    translating: "AI is translating context...",
    stitching: "Stitching images...",
    done: "Done",
    stopped_by_user: "Stopped by user",
    
    // Badge Status
    status_pending: "PENDING",
    status_processing: "PROCESSING",
    status_completed: "DONE",
    status_failed: "FAILED",
    
    // Canvas
    readyToCreate: "Ready to Create",
    uploadHint: "Upload via sidebar or paste from clipboard (Ctrl+V)",
    
    // Global Settings
    globalSettings: "Global Settings",
    enableMangaMode: "Enable Manga Module",
    enableMangaModeDesc: "Enables bubble detection, OCR, editor, and other manga tools",
    enableBubbleDetection: "Enable Bubble Detection",
    enableBubbleDetectionDesc: "Show auto-detection tools in sidebar",
    enableOCR: "Enable OCR",
    enableOCRDesc: "Show text recognition buttons on regions",
    enableManualEditor: "Enable Patch Editor",
    enableManualEditorDesc: "Enable brush and typesetting tools",
    enableVerticalTextDefault: "Default Vertical Text",
    enableVerticalTextDefaultDesc: "New text boxes default to Vertical orientation",
    useFullImageMasking: "Use Full Image Masking",
    useFullImageMaskingDesc: "Send masked full image to API instead of crops. Reduces API calls and provides better context.",
    useInvertedMasking: "Inverted Masking (Repaint Background)",
    useInvertedMaskingDesc: "Masks selected regions (white) for AI to fill background. Original regions are stitched back on top. Best for keeping subjects unchanged.",
    fullImageOpaquePercent: "Edge Blending Opaque (%)",
    fullImageOpaquePercentDesc: "Center opacity percentage. 99% means only the outer 1% is feathered for blending.",
    
    // Translation Mode
    enableTranslationMode: "Enable Translation Mode",
    enableTranslationModeDesc: "Pre-process image with LLM to translate text and provide context to the painting model.",
    translationSettings: "Translation Settings (OpenAI)",
    translationPromptLabel: "System Prompt",
    translationPromptPlaceholder: "e.g., Translate text...",
    reset: "Reset",
    resetToDefault: "Reset to Default",
    close: "Close",

    // --- HELP CONTENT ---
    helpTitle: "Guide & Tricks",
    
    // Tabs
    help_tab_basics: "🚀 Basics",
    help_tab_manga: "📖 Manga Tools",
    help_tab_pro: "⚡ Pro Features",
    help_tab_editor: "🎨 Editor",
    help_tab_tricks: "🧙‍♂️ Hidden Tricks",

    // Content - Basics
    help_basics_1_title: "1. Upload",
    help_basics_1_desc: "Upload files or folders via the sidebar. You can also paste images (Ctrl+V) directly.",
    help_basics_2_title: "2. Select",
    help_basics_2_desc: "Draw rectangular regions on the canvas over areas you want to modify (watermarks, text, etc.).",
    help_basics_3_title: "3. Prompt",
    help_basics_3_desc: "Enter a prompt. Use the Global Prompt for all regions, or select a region to set a specific prompt.",
    help_basics_4_title: "4. Generate",
    help_basics_4_desc: "Configure your API key and click Generate. Use 'Apply to All' for batch processing.",

    // Content - Manga
    help_manga_1_title: "Auto-Detect Bubbles",
    help_manga_1_desc: "Enable 'Manga Module' in settings. Use 'Auto Detect' to find all text bubbles instantly (Requires Python Backend).",
    help_manga_2_title: "OCR",
    help_manga_2_desc: "Enable OCR to see text recognition buttons on regions. Useful for extracting original text.",
    help_manga_3_title: "Translation Mode",
    help_manga_3_desc: "Reads and translates text before painting, sending the translation as context to the AI for better accuracy.",

    // Content - Pro
    help_pro_1_title: "Full Image Masking",
    help_pro_1_desc: "Instead of sending 10 requests for 10 bubbles, this mode sends 1 masked image. Faster, cheaper, and better context.",
    help_pro_2_title: "Apply as Original",
    help_pro_2_desc: "Turn your result into the new 'Original' image. Allows for iterative editing and refinement.",
    help_pro_3_title: "Concurrency",
    help_pro_3_desc: "Adjust the number of parallel requests in 'Processing Options' to maximize speed or avoid rate limits.",

    // Content - Editor
    help_editor_1_title: "Patch Editor",
    help_editor_1_desc: "Click the 'Edit' icon on any region to open the full manual editor.",
    help_editor_2_title: "Brush & Fill",
    help_editor_2_desc: "Erase content with the brush. 'Fill All' instantly cleans a text bubble.",
    help_editor_3_title: "Typesetting",
    help_editor_3_desc: "Add text with support for vertical writing, outlines, and bold fonts. Scroll to resize text.",

    // Content - Tricks (Hidden)
    help_tricks_1_title: "⌨️ Keyboard Navigation",
    help_tricks_1_desc: "Use Arrow Keys (↑ ↓ ← →) to quickly switch between images. Ctrl+Z/Y for Undo/Redo in editor.",
    help_tricks_2_title: "🖱️ Mouse Wheel Actions",
    help_tricks_2_desc: "In Editor: Ctrl+Wheel zooms canvas. Hovering a text box + Wheel changes font size.",
    help_tricks_3_title: "🛡️ Safety Clear",
    help_tricks_3_desc: "The 'Clear Gallery' button requires a Double Click to execute, preventing accidental data loss.",
    help_tricks_4_title: "📂 Batch Upload",
    help_tricks_4_desc: "Use the 'Upload Folder' icon to load hundreds of images at once.",
  }
};

export const t = (lang: Language, key: keyof typeof translations['en'], params?: Record<string, string | number>) => {
  let text = translations[lang][key] || translations['en'][key] || key;
  
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, String(v));
    });
  }
  
  return text;
};