
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
    
    // Prompt
    promptTitle: "提示词",
    promptGlobalLabel: "全局默认提示词",
    promptSpecificLabel: "当前图片专用提示词",
    promptPlaceholder: "描述你想要修改的内容 (例如: 去除水印, 换成蓝天)...",
    promptSpecificPlaceholder: "在此追加针对本图的额外细节描述...",
    
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
    
    // Guide: Sections
    guide_sec_basics: "核心流程",
    guide_sec_advanced: "高级功能 & 技巧",
    
    // Guide: Steps
    guide_step_upload: "1. 上传与管理",
    guide_step_upload_desc: "上传文件或文件夹。你可以对不需要处理的图片点击左上角【跳过】。",
    guide_step_region: "2. 框选区域",
    guide_step_region_desc: "在画布上框选想修改的区域。支持多选区。",
    guide_step_config: "3. 配置 AI",
    guide_step_config_desc: "填写 Key。Gemini 适合快速处理，OpenAI 适合精细化修补。",
    guide_step_run: "4. 批量执行",
    guide_step_run_desc: "勾选底部的【应用到所有】，一键处理整个列表。",
    
    // Guide: Tips
    guide_tip_batch_title: "⚡ 批量处理技巧",
    guide_tip_batch_desc: "如果你有一组构图相似的图片（如视频帧），只需在第一张图画好选区和提示词，勾选【应用到所有】即可复用。",
    guide_tip_timeout_title: "🐢 网络超时问题",
    guide_tip_timeout_desc: "如果遇到 'Timeout' 错误，请在【处理选项】中增加超时时间（默认150秒）或减少并发数量。",
    guide_tip_manual_title: "🎨 手动修补模式",
    guide_tip_manual_desc: "切换到【手动模式】，你可以复制原始切片到 Photoshop 处理，然后直接 Ctrl+V 粘贴回网页回填区，自动合成。",
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
    
    // Prompt
    promptTitle: "Prompt",
    promptGlobalLabel: "Global Default Prompt",
    promptSpecificLabel: "Current Image Prompt",
    promptPlaceholder: "Describe the edit...",
    promptSpecificPlaceholder: "Append specific details to global prompt...",
    
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
    
    guide_sec_basics: "Core Workflow",
    guide_sec_advanced: "Advanced & Tips",
    
    guide_step_upload: "1. Upload & Manage",
    guide_step_upload_desc: "Upload files or folders. Use the 'Skip' button on thumbnails to exclude images.",
    guide_step_region: "2. Draw Regions",
    guide_step_region_desc: "Draw boxes over areas to edit. Multiple regions supported.",
    guide_step_config: "3. Configure AI",
    guide_step_config_desc: "Set your API Key. Gemini is fast; OpenAI is precise.",
    guide_step_run: "4. Batch Execute",
    guide_step_run_desc: "Check 'Apply to all' at the bottom to process the entire list at once.",
    
    guide_tip_batch_title: "⚡ Batch Processing",
    guide_tip_batch_desc: "For similar images (e.g., video frames), set regions/prompts on the first image and use 'Apply to all' to replicate settings.",
    guide_tip_timeout_title: "🐢 Timeout Issues",
    guide_tip_timeout_desc: "If you see 'Timeout' errors, increase the Timeout setting (default 150s) or lower concurrency in Options.",
    guide_tip_manual_title: "🎨 Manual Mode",
    guide_tip_manual_desc: "Switch to Manual Mode to copy source crops, edit them in Photoshop, and paste them back to auto-stitch.",
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
