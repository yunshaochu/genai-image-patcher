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
    promptPlaceholder: "描述你想要修改的内容 (例如: 去除水印, 换成蓝天)...",
    promptSpecificPlaceholder: "在此追加针对此区域的额外细节描述...", 
    
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
    
    // Guide (Structured)
    guideTitle: "使用指南与技巧",
    close: "关闭",
    
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
    
    // Guide: Sections
    guide_sec_basics: "核心流程",
    guide_sec_advanced: "高级使用技巧",
    guide_sec_manga: "漫画模块与衍生功能",
    
    // Guide: Steps
    guide_step_upload: "上传图片",
    guide_step_upload_desc: "从侧边栏上传或 Ctrl+V 粘贴。支持文件夹批量载入。",
    guide_step_region: "框选区域",
    guide_step_region_desc: "在画布拖动鼠标创建选区。每个选区可以有独立的 AI 提示词。",
    guide_step_config: "模式切换",
    guide_step_config_desc: "使用【AI 生成】模式自动处理，或切换到【手动模式】进行精细修补。",
    guide_step_run: "执行处理",
    guide_step_run_desc: "点击开始生成。勾选【应用到所有】可一键批量处理图库。",
    
    // Guide: Tips
    guide_tip_manga_title: "📖 什么是漫画模块？",
    guide_tip_manga_desc: "这是为漫画汉化和修图衍生的增强功能。开启后，你可以利用后端 Python 接口自动识别气泡、进行 OCR 识别，并使用内置的画笔涂抹和文字嵌字工具。",
    guide_tip_editor_title: "🎨 修补编辑器 (手动功能)",
    guide_tip_editor_desc: "在【手动修补工坊】中，悬停图片区域会出现【编辑】按钮。你可以直接在这里涂抹掉原始内容，并添加新的文本（支持横排、竖排和描边）。",
    guide_tip_batch_title: "⚡ 批量气泡检测",
    guide_tip_batch_desc: "如果你有一百张漫画，只需开启【漫画模块】->【气泡检测】，选择【所有图片】并点击自动检测，即可一键完成全选区的建立。",
    guide_tip_manual_title: "🎨 手动处理",
    guide_tip_manual_desc: "在【补丁工坊】中，你可以对每个选区进行手动编辑。支持直接粘贴图片或使用内置编辑器进行涂抹和嵌字。",
    guide_tip_timeout_title: "⏳ 超时与重试",
    guide_tip_timeout_desc: "如果 AI 响应缓慢导致超时，可以尝试增加侧边栏【执行选项】中的超时时间，或者增加重试次数以应对不稳定的网络。",
  },
  en: {
    appTitle: "Patcher Pro",
    appSubtitle: "AI Image Editor",
    
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
    clearGalleryConfirm: "Are you sure you want to clear all images? This cannot be undone.",
    
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
    promptPlaceholder: "Describe the edit...",
    promptSpecificPlaceholder: "Append specific details for this region...", 
    
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
    
    // Guide
    guideTitle: "User Guide & Tips",
    close: "Close",
    
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
    
    guide_sec_basics: "Core Workflow",
    guide_sec_advanced: "Advanced Tips",
    guide_sec_manga: "Manga Module Extensions",
    
    guide_step_upload: "Upload",
    guide_step_upload_desc: "Upload via sidebar or paste image. Batch folder loading supported.",
    guide_step_region: "Draw Regions",
    guide_step_region_desc: "Click and drag on canvas to create regions. Each can have its own prompt.",
    guide_step_config: "Pick Workflow",
    guide_step_config_desc: "Use AI mode for automation, or Manual mode for precision patching.",
    guide_step_run: "Generate",
    guide_step_run_desc: "Start processing. Toggle 'Apply to all' for bulk tasks.",
    
    guide_tip_manga_title: "📖 What is Manga Module?",
    guide_tip_manga_desc: "It's an extension for manga scanlation. When enabled, you can auto-detect text bubbles, run OCR, and use built-in tools for cleaning and typesetting.",
    guide_tip_editor_title: "🎨 Patch Editor (Manual)",
    guide_tip_editor_desc: "In Manual Workbench, hover a region to find the Edit button. Use the brush to erase content and the text tool to add new translations with ease.",
    guide_tip_batch_title: "⚡ Batch Auto-Detection",
    guide_tip_batch_desc: "Process hundreds of pages at once by setting detection scope to 'All Images' in the Manga Toolkit.",
    guide_tip_manual_title: "🎨 Manual Processing",
    guide_tip_manual_desc: "In the Patch Workbench, you can manually edit each region. You can paste processed images directly or use the built-in editor for erasing and typesetting.",
    guide_tip_timeout_title: "⏳ Timeout & Retries",
    guide_tip_timeout_desc: "If the AI is slow and causes timeouts, try increasing the 'Timeout' in the Execution Options or adding retries for unstable connections.",
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