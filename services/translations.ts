
import { Language } from "../types";

export const translations = {
  zh: {
    appTitle: "AI 图像修补 Pro",
    appSubtitle: "AI 局部重绘工具",
    
    // Upload
    uploadFiles: "上传文件",
    uploadFolder: "上传文件夹",
    
    // Gallery
    galleryTitle: "图库",
    selectToEdit: "点击选择编辑",
    downloadZip: "下载压缩包",
    zipping: "压缩中...",
    
    // Prompt
    promptTitle: "提示词",
    promptPlaceholder: "描述你想要修改的内容 (例如: 去除水印, 换成蓝天)...",
    
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
    
    // Preview
    previewTitle: "补丁预览",
    
    // Actions
    applyAll: "应用到所有 {count} 张图片",
    generate: "开始生成",
    generateAll: "批量生成所有",
    downloadResult: "下载最终结果",
    
    // Status
    idle: "空闲",
    cropping: "正在裁剪区域...",
    api_calling: "AI 正在思考...",
    stitching: "正在合成图片...",
    done: "完成",
    
    // Badge Status
    status_pending: "等待中",
    status_processing: "处理中",
    status_completed: "已完成",
    status_failed: "失败",
    
    // Canvas
    readyToCreate: "准备开始",
    uploadHint: "通过左侧上传图片，或直接粘贴 (Ctrl+V)",
    
    // Guide
    guideTitle: "使用指南",
    guideStep1: "1. 上传图片：支持单张或文件夹批量上传。",
    guideStep2: "2. 框选区域：在中间画布上框选你想修改的地方。",
    guideStep3: "3. 选择模式：使用【AI 自动生成】或【手动修补工坊】。",
    guideStep4: "4. 执行：AI 模式配置 Key 后点击生成；手动模式复制切片，处理后粘贴回填。",
    guideStep5: "5. 下载：生成完成后下载最终结果。",
    guideTips: "提示：手动模式下，Ctrl+V 粘贴在回填区只会更新切片，不会上传新图。",
    close: "关闭"
  },
  en: {
    appTitle: "Patcher Pro",
    appSubtitle: "AI Image Editor",
    
    // Upload
    uploadFiles: "Files",
    uploadFolder: "Folder",
    
    // Gallery
    galleryTitle: "Gallery",
    selectToEdit: "Select to edit",
    downloadZip: "Download Zip",
    zipping: "Zipping...",
    
    // Prompt
    promptTitle: "Prompt",
    promptPlaceholder: "Describe the edit...",
    
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
    
    // Preview
    previewTitle: "Patch Previews",
    
    // Actions
    applyAll: "Apply to all {count} images",
    generate: "Generate Patches",
    generateAll: "Generate All Patches",
    downloadResult: "Download Result",
    
    // Status
    idle: "Idle",
    cropping: "Cropping regions...",
    api_calling: "AI is processing...",
    stitching: "Stitching images...",
    done: "Done",
    
    // Badge Status
    status_pending: "PENDING",
    status_processing: "PROCESSING",
    status_completed: "DONE",
    status_failed: "FAILED",
    
    // Canvas
    readyToCreate: "Ready to Create",
    uploadHint: "Upload via sidebar or paste from clipboard (Ctrl+V)",
    
    // Guide
    guideTitle: "User Guide",
    guideStep1: "1. Upload: Select files or folders via the sidebar.",
    guideStep2: "2. Select: Draw rectangles on the canvas over areas to edit.",
    guideStep3: "3. Mode: Choose 'AI Generation' or 'Patch Workbench'.",
    guideStep4: "4. Execute: Configure Key for AI; or Copy/Paste patches for Manual.",
    guideStep5: "5. Download: Save the final stitched result.",
    guideTips: "Tip: In Manual Mode, pasting into the Drop Zone only updates the patch.",
    close: "Close"
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
