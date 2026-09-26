/**
 * 编辑器嵌字字体。
 *
 * 字体文件不在前端打包，也不直接去国外 CDN 下载（慢且容易失败），而是统一由
 * Python 后端代理：后端首次请求时下载并缓存到 server/fonts/，之后前端从后端
 * 取（浏览器再缓存一层）。这里只负责「登记字体信息」+「按需把字体注册进
 * document.fonts」，让 canvas 的 measureText / fillText 能用上它。
 *
 * 与后端 server/app.py 的 FONT_LIBRARY 一一对应：id / family 必须保持一致。
 */

export interface EditorFontMeta {
  /** 与后端 /fonts/<id> 对应的 id。 */
  id: string;
  /** 注册到 document.fonts 的 CSS family 名（与字体文件内的名字保持一致）。 */
  family: string;
  label: { zh: string; en: string };
  /** family 之后兜底的字体族，字体缺失时不至于掉回浏览器默认的怪字体。 */
  fallback: string;
  /**
   * 给「字体自动识别」的视觉模型看的风格说明（中文，与翻译提示词一致）。
   * 模型靠这句判断原文属于哪种字体，所以写的是「什么样子」，不是名字。
   */
  aiHint: string;
}

/** 默认字体的 font id（不下载任何文件，等价于改动前的行为）。 */
export const SYSTEM_FONT_ID = '';

/**
 * 「默认字体」的 CSS 栈。
 *
 * 以前这里是 CSS 泛型族 `sans-serif` —— 它本身没有名字，具体落到哪个字体由浏览器
 * 和操作系统决定（Windows 中文环境 Chrome 实际用的是微软雅黑），所以列表里只能
 * 写「系统默认」，看不出到底会用哪个字体。
 * 现在显式点名：中文优先微软雅黑，macOS 用苹方，都没有时再退回浏览器默认无衬线
 * 字体。渲染结果与 `sans-serif` 在中文下基本一致，但字体是确定的、有名字的。
 */
export const SYSTEM_FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Heiti SC", sans-serif';

export const EDITOR_FONTS: EditorFontMeta[] = [
  {
    id: 'zcool-kuaile',
    family: 'ZCOOL KuaiLe',
    label: { zh: '站酷快乐体（圆润可爱）', en: 'ZCOOL KuaiLe (rounded & cute)' },
    fallback: 'sans-serif',
    aiHint: '圆润可爱的卡通气泡体，笔画粗细均匀、转角圆润、带手写感；常见于萌系对白、轻快语气、标题',
  },
  {
    id: 'mashanzheng',
    family: 'Ma Shan Zheng',
    label: { zh: '马善政毛笔楷书', en: 'Ma Shan Zheng (brush script)' },
    fallback: 'serif',
    aiHint: '毛笔书法体，有明显毛笔笔锋、粗细变化大、带飞白；常见于标题、拟声词、强调语气、古风',
  },
];

export const getEditorFont = (id: string | undefined | null): EditorFontMeta | undefined =>
  id ? EDITOR_FONTS.find(f => f.id === id) : undefined;

/**
 * 字体 id → canvas/CSS 用的字体栈。'' 或未知 id → 系统默认（sans-serif）。
 *
 * 说明：`textLayout.buildFont` 会拼成 `bold 20px <stack>`，所以这里返回的
 * 是完整的 family 列表；字体没加载成功时浏览器会自动落到 fallback 上。
 */
export const editorFontStack = (id: string | undefined | null): string => {
  const meta = getEditorFont(id);
  return meta ? `"${meta.family}", ${meta.fallback}` : SYSTEM_FONT_STACK;
};

/**
 * 反向解析：区域上存的是字体栈（`editorStyle.fontFamily`），这里还原成字体 id。
 * 系统默认栈 / 未知栈都返回 undefined（= 不需要下载任何字体文件）。
 */
export const fontIdFromStack = (stack: string | undefined | null): string | undefined => {
  if (!stack) return undefined;
  return EDITOR_FONTS.find(f => editorFontStack(f.id) === stack)?.id;
};

/** 「字体自动识别」的模型返回值里代表「常规印刷体」的约定值。 */
export const AI_DEFAULT_FONT_KEY = 'default';

/**
 * 「字体自动识别」用：给模型看的内置字体清单。
 *
 * 生成的每一行都是 `- "<模型应回填的字符串>"：<风格说明>`，同时也是解析的
 * 白名单来源（见 resolveFontIdFromAi）。
 */
export const buildFontChoicePrompt = (): string =>
  [
    `- "${AI_DEFAULT_FONT_KEY}"：常规印刷体（黑体、明体等标准字体，没有明显风格特征；绝大多数字都用这个）`,
    ...EDITOR_FONTS.map(f => `- "${f.id}"：${f.aiHint}`),
  ].join('\n');

/**
 * 把模型返回的字体值解析成字体 id。
 *
 * 明确说「常规印刷体」→ 返回 SYSTEM_FONT_ID（空串），调用方应当把它当作
 * 「不覆盖」，让该区域继续跟随全局「编辑器字体」——模型只在能看出风格差异时
 * 才应该改字体，否则用户设的全局字体就不起作用了。
 *
 * 除了 id 本身，也容忍模型回英文 family 名（"ZCOOL KuaiLe"）或中英标签，宽容
 * 一点总比因为措辞不同丢掉整个识别结果好。认不出来返回 undefined。
 */
export const resolveFontIdFromAi = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();

  if (
    lower === AI_DEFAULT_FONT_KEY ||
    lower === 'system' || lower === 'system default' ||
    lower === 'sans-serif' || lower === 'print' || lower === '常规印刷体' ||
    value.includes('默认') || value.includes('印刷体')
  ) {
    return SYSTEM_FONT_ID;
  }

  for (const f of EDITOR_FONTS) {
    if (lower === f.id.toLowerCase() || lower === f.family.toLowerCase()) return f.id;
    // 中英标签（去掉括号里的说明）："站酷快乐体（圆润可爱）" → "站酷快乐体"
    const zhLabel = f.label.zh.replace(/[（(].*?[）)]/g, '').trim();
    const enLabel = f.label.en.replace(/[（(].*?[）)]/g, '').trim().toLowerCase();
    if (value === zhLabel || lower === enLabel) return f.id;
    // 只回了家族名的一部分（"ZCOOL"、"马善政"）也算命中
    if (zhLabel.length >= 2 && value.includes(zhLabel)) return f.id;
    if (f.family.length >= 4 && lower.includes(f.family.toLowerCase())) return f.id;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// 加载（下载 + 注册 FontFace）
// ---------------------------------------------------------------------------

/** id → 已注册的 FontFace（下载并解析成功后才写入）。 */
const loadedFaces = new Map<string, FontFace[]>();
/** id → 进行中的加载 Promise，避免并发重复下载。 */
const pendingLoads = new Map<string, Promise<void>>();

export const isEditorFontLoaded = (id: string): boolean => loadedFaces.has(id);

/**
 * 确保字体可用：从后端拉一次字体文件并注册为 FontFace。
 *
 * - 同一个字体在一个页面会话里只会下载一次（后端/浏览器还各有一层缓存）。
 * - 失败时不会缓存失败的 Promise，下次调用会重试。
 * - 下载成功后必须 `await` 完成，否则 canvas 的 measureText 会退回默认字体的
 *   度量，自动字号会算错。
 */
export const ensureEditorFontLoaded = (
  fontId: string,
  backendBaseUrl?: string
): Promise<void> => {
  const meta = getEditorFont(fontId);
  if (!meta || !backendBaseUrl) return Promise.resolve();
  if (loadedFaces.has(fontId)) return Promise.resolve();

  const inflight = pendingLoads.get(fontId);
  if (inflight) return inflight;

  const task = (async () => {
    const base = backendBaseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${base}/fonts/${fontId}`);
    if (!resp.ok) {
      throw new Error(`字体下载失败 (HTTP ${resp.status})`);
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength < 1024) {
      throw new Error('字体文件无效（后端返回的内容过短）');
    }
    // 同一个文件注册 normal + bold 两个字重：装饰性中文字体做伪粗体（浏览器
    // 合成的 bold）会发虚、边缘发毛，直接复用原始字形更干净。嵌字默认 isBold
    // 为 true，所以 bold 这一档必须存在。
    const faces = [
      new FontFace(meta.family, buf, { weight: '400' }),
      new FontFace(meta.family, buf.slice(0), { weight: '700' }),
    ];
    for (const face of faces) {
      document.fonts.add(face);
      await face.load();
    }
    loadedFaces.set(fontId, faces);
  })();

  pendingLoads.set(fontId, task);
  const clear = () => pendingLoads.delete(fontId);
  task.then(clear, clear);
  return task;
};

/** 卸载（换字体时释放内存；不是必须的，但字体文件本身有 1.5–8MB）。 */
export const unloadEditorFont = (fontId: string): void => {
  const faces = loadedFaces.get(fontId);
  if (!faces) return;
  for (const face of faces) {
    try { document.fonts.delete(face); } catch { /* ignore */ }
  }
  loadedFaces.delete(fontId);
};
