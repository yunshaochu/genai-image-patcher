import { Region, UploadedImage, ImageHistoryState, RedrawIntent, GlossaryTerm, DetectionStatus } from '../types';
import { migratePromptToTranslation } from './translationCache';
import { sanitizeBook } from './glossaryBook';

/**
 * Session persistence (IndexedDB).
 *
 * All work state lives in React memory as blob: Object URLs, so a tab discard
 * (Chrome "Memory Saver" / Edge sleeping tabs), reload or crash wipes it out.
 * This module mirrors the image store into IndexedDB — Blobs are stored
 * directly (structured clone, no JS-memory duplication) — and rebuilds the
 * store with fresh Object URLs on the next launch.
 *
 * Tradeoffs:
 * - Undo/redo history is NOT persisted; on restore each image gets a single
 *   history entry built from its current state.
 * - Regions stuck in 'processing' at save time are restored as 'pending'
 *   (the in-flight API call no longer exists after a reload).
 */

const DB_NAME = 'banana-change-session';
const DB_VERSION = 3;
const IMAGE_STORE = 'images';
const META_STORE = 'meta';
const ERASE_STORE = 'erase';
const META_KEY = 'session';

/** blob: URLs are fetched to Blobs; data:/http(s) URLs are kept as strings.
 *  Also reused by workStateTransfer.ts, which writes the same records into a
 *  ZIP instead of IndexedDB. */
export type PersistableUrl = Blob | string | undefined;

export type RegionRecord = Omit<Region, 'processedImageUrl' | 'restoreMaskUrl' | 'editorBrushUrl' | 'aiEraseBaseUrl'> & {
  processed?: PersistableUrl;
  restoreMask?: PersistableUrl;
  editorBrush?: PersistableUrl;
  /** AI「擦除」产物的干净底图（见 Region.aiEraseBaseUrl）。 */
  aiEraseBase?: PersistableUrl;
};

export interface ImageRecord {
  id: string;
  file: File;
  /** undefined = identical to originalUrl (recreated from `file` on restore) */
  preview?: PersistableUrl;
  thumbnail?: PersistableUrl;
  finalResult?: PersistableUrl;
  fullAi?: PersistableUrl;
  originalWidth: number;
  originalHeight: number;
  isSkipped?: boolean;
  customPrompt?: string;
  /** 全图遮罩模式下的图片级意图 / 各 tab 提示词 / 译文（见 UploadedImage）。 */
  redrawIntent?: RedrawIntent;
  customPromptErase?: string;
  customPromptFree?: string;
  customTranslation?: string;
  /** previewUrl is a committed 应用为原图 result (see UploadedImage). */
  appliedAsOriginal?: boolean;
  /** 自动检测气泡的记忆（见 UploadedImage.detectionStatus）。 */
  detectionStatus?: DetectionStatus;
  regions: RegionRecord[];
}

interface MetaRecord {
  key: string;
  order: string[];
  selectedImageId: string | null;
  savedAt: number;
}

export interface SessionImageStore {
  byId: Record<string, UploadedImage>;
  order: string[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGE_STORE)) {
          db.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(ERASE_STORE)) {
          // 擦除缓存（见下方 EraseRecord）：key = 调用方拼的完整缓存键；
          // regionId 索引用于「同一个框只留最新一条」，imageId 索引用于按图库清理，
          // savedAt 索引用于条数超限时淘汰最旧的。
          const store = db.createObjectStore(ERASE_STORE, { keyPath: 'key' });
          store.createIndex('regionId', 'regionId', { unique: false });
          store.createIndex('imageId', 'imageId', { unique: false });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        } else {
          // 已存在的库（老版本建过一次）：补上之后新增的索引。
          const store = req.transaction!.objectStore(ERASE_STORE);
          if (!store.indexNames.contains('imageId')) {
            store.createIndex('imageId', 'imageId', { unique: false });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Best-effort: ask the browser not to evict this origin's storage under disk pressure.
    try { void navigator.storage?.persist?.(); } catch { /* ignore */ }
  }
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function urlToPersistable(url: string | undefined): Promise<PersistableUrl> {
  if (!url) return undefined;
  if (url.startsWith('blob:')) {
    try {
      return await (await fetch(url)).blob();
    } catch {
      return undefined; // URL already revoked — nothing to save
    }
  }
  return url; // data: / http(s): URLs survive as plain strings
}

function persistableToUrl(p: PersistableUrl): string | undefined {
  if (!p) return undefined;
  return typeof p === 'string' ? p : URL.createObjectURL(p);
}

export async function serializeImage(img: UploadedImage): Promise<ImageRecord> {
  const [preview, thumbnail, finalResult, fullAi] = await Promise.all([
    img.previewUrl !== img.originalUrl ? urlToPersistable(img.previewUrl) : Promise.resolve(undefined),
    urlToPersistable(img.thumbnailUrl),
    urlToPersistable(img.finalResultUrl),
    urlToPersistable(img.fullAiResultUrl),
  ]);
  const regions: RegionRecord[] = await Promise.all(
    img.regions.map(async (r) => {
      const { processedImageUrl, restoreMaskUrl, editorBrushUrl, aiEraseBaseUrl, ...scalars } = r;
      const [processed, restoreMask, editorBrush, aiEraseBase] = await Promise.all([
        urlToPersistable(processedImageUrl),
        urlToPersistable(restoreMaskUrl),
        urlToPersistable(editorBrushUrl),
        urlToPersistable(aiEraseBaseUrl),
      ]);
      return { ...scalars, processed, restoreMask, editorBrush, aiEraseBase };
    })
  );
  return {
    id: img.id,
    file: img.file,
    preview,
    thumbnail,
    finalResult,
    fullAi,
    originalWidth: img.originalWidth,
    originalHeight: img.originalHeight,
    isSkipped: img.isSkipped,
    customPrompt: img.customPrompt,
    redrawIntent: img.redrawIntent,
    customPromptErase: img.customPromptErase,
    customPromptFree: img.customPromptFree,
    customTranslation: img.customTranslation,
    appliedAsOriginal: img.appliedAsOriginal,
    detectionStatus: img.detectionStatus,
    regions,
  };
}

export function deserializeImage(rec: ImageRecord): UploadedImage {
  const originalUrl = URL.createObjectURL(rec.file);
  const previewUrl = persistableToUrl(rec.preview) ?? originalUrl;
  const thumbnailUrl = persistableToUrl(rec.thumbnail) ?? previewUrl;
  const finalResultUrl = persistableToUrl(rec.finalResult);
  const fullAiResultUrl = persistableToUrl(rec.fullAi);
  const regions: Region[] = rec.regions.map((r) => {
    const { processed, restoreMask, editorBrush, aiEraseBase, ...scalars } = r;
    // OCR 功能已移除：老会话里 ocrText 存的是「识别出的原文」，迁到 sourceText
    // 继续展示；其余 OCR 痕迹（加载态）直接丢弃。
    const legacyOcrText = (scalars as any).ocrText as string | undefined;
    delete (scalars as any).ocrText;
    delete (scalars as any).isOcrLoading;
    // 迁移：把旧版塞在 customPrompt 里的 marker 译文块拆到 customTranslation。
    const trans = migratePromptToTranslation(scalars.customPrompt);
    return {
      ...scalars,
      customPrompt: trans.prompt,
      customTranslation: scalars.customTranslation ?? trans.translation,
      sourceText: scalars.sourceText ?? legacyOcrText,
      // No API call is in flight after a reload — never restore 'processing'.
      status: scalars.status === 'processing' ? 'pending' : scalars.status,
      processedImageUrl: persistableToUrl(processed),
      restoreMaskUrl: persistableToUrl(restoreMask),
      editorBrushUrl: persistableToUrl(editorBrush),
      aiEraseBaseUrl: persistableToUrl(aiEraseBase),
    };
  });
  const initialState: ImageHistoryState = {
    previewUrl,
    regions,
    finalResultUrl,
    width: rec.originalWidth,
    height: rec.originalHeight,
    fullAiResultUrl,
    appliedAsOriginal: rec.appliedAsOriginal,
  };
  // 迁移：图片级 customPrompt 里的 marker 译文块同样拆到 customTranslation。
  const imgTrans = migratePromptToTranslation(rec.customPrompt);
  return {
    id: rec.id,
    file: rec.file,
    previewUrl,
    originalUrl,
    thumbnailUrl,
    originalWidth: rec.originalWidth,
    originalHeight: rec.originalHeight,
    regions,
    finalResultUrl,
    fullAiResultUrl,
    isSkipped: rec.isSkipped,
    customPrompt: imgTrans.prompt,
    redrawIntent: rec.redrawIntent,
    customPromptErase: rec.customPromptErase,
    customPromptFree: rec.customPromptFree,
    customTranslation: rec.customTranslation ?? imgTrans.translation,
    appliedAsOriginal: rec.appliedAsOriginal,
    detectionStatus: rec.detectionStatus,
    history: [initialState],
    historyIndex: 0,
  };
}

/**
 * Incrementally persist the store. `savedRefs` maps image id → the exact
 * UploadedImage object reference last written; because the store is updated
 * immutably, unchanged images are skipped without re-serializing their blobs.
 * The map is mutated in place (only after a successful commit).
 */
export async function saveSession(
  store: SessionImageStore,
  selectedImageId: string | null,
  savedRefs: Map<string, UploadedImage>
): Promise<void> {
  const changed: ImageRecord[] = [];
  for (const id of store.order) {
    const img = store.byId[id];
    if (!img) continue;
    if (savedRefs.get(id) === img) continue;
    changed.push(await serializeImage(img));
  }
  const removed: string[] = [];
  for (const id of Array.from(savedRefs.keys())) {
    if (!store.byId[id]) removed.push(id);
  }

  const db = await openDb();
  const tx = db.transaction([IMAGE_STORE, META_STORE], 'readwrite');
  const imageStore = tx.objectStore(IMAGE_STORE);
  for (const rec of changed) imageStore.put(rec);
  for (const id of removed) imageStore.delete(id);
  const meta: MetaRecord = {
    key: META_KEY,
    order: [...store.order],
    selectedImageId,
    savedAt: Date.now(),
  };
  tx.objectStore(META_STORE).put(meta);
  await txDone(tx);

  for (const rec of changed) savedRefs.set(rec.id, store.byId[rec.id]);
  for (const id of removed) savedRefs.delete(id);
}

/** Returns null when there is no saved session (or it was cleared). */
export async function loadSession(): Promise<{
  images: UploadedImage[];
  selectedImageId: string | null;
} | null> {
  const db = await openDb();
  const tx = db.transaction([IMAGE_STORE, META_STORE], 'readonly');
  const [meta, records] = await Promise.all([
    requestToPromise(tx.objectStore(META_STORE).get(META_KEY)) as Promise<MetaRecord | undefined>,
    requestToPromise(tx.objectStore(IMAGE_STORE).getAll()) as Promise<ImageRecord[]>,
  ]);
  if (!meta || !records || records.length === 0) return null;

  const recordById: Record<string, ImageRecord> = {};
  for (const r of records) recordById[r.id] = r;

  const images: UploadedImage[] = [];
  for (const id of meta.order) {
    const rec = recordById[id];
    if (rec) images.push(deserializeImage(rec));
  }
  if (images.length === 0) return null;

  const selectedImageId =
    meta.selectedImageId && images.some((i) => i.id === meta.selectedImageId)
      ? meta.selectedImageId
      : images[0].id;
  return { images, selectedImageId };
}

export async function clearSession(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([IMAGE_STORE, META_STORE, ERASE_STORE], 'readwrite');
  tx.objectStore(IMAGE_STORE).clear();
  tx.objectStore(META_STORE).clear();
  tx.objectStore(ERASE_STORE).clear();
  await txDone(tx);
}

// -------------------- 泛洪擦除底图缓存 --------------------
//
// 编辑器「泛洪擦除」一次要跑完整条像素管线（离线时是主线程同步算法，秒级），
// 而结果只跟「框几何 + 擦除 ROI + 底图变体」有关 —— 会话重开后图形一模一样，
// 没理由再擦一遍。这里按调用方给的完整缓存键把擦除后的 ROI 落盘，重开编辑器时
// 直接命中；只有用户主动改变输入（撤回擦除 / 拖动改几何 / 应用为原图）才会生成
// 新键，才会重新擦除。
//
// 纯粹是性能缓存：任何时刻删掉都只是"下次重擦"，不影响正确性。随会话一起清。

export interface EraseRecord {
  /** 完整缓存键，由调用方拼（含 imageId / 底图变体 / 框几何 / ROI）。 */
  key: string;
  imageId: string;
  regionId: string;
  /** 擦除后的 ROI 位图（无损 PNG）。 */
  blob: Blob;
  /** 区域裁剪在 ROI 里的偏移与 ROI 尺寸（px）。 */
  dx: number;
  dy: number;
  w: number;
  h: number;
  /** 擦除时量到的墨色 / 底色（自动取色沿用，避免重擦后颜色跳变）。 */
  textColor?: string;
  bgColor?: string;
  savedAt: number;
}

/** 全局条数上限：超过就按 savedAt 淘汰最旧的，防止长期积累（每框最多一条）。 */
const ERASE_MAX_ENTRIES = 400;

/**
 * 读一条擦除缓存；不存在 / 结构不对（老版本残留）/ 读盘出错时一律返回 null
 * （缓存读不到只是「这次重新擦」，绝不能让 IndexedDB 的毛病打断合成）。
 */
export async function loadEraseRecord(key: string): Promise<EraseRecord | null> {
  try {
    const db = await openDb();
    const tx = db.transaction([ERASE_STORE], 'readonly');
    const rec = await requestToPromise(
      tx.objectStore(ERASE_STORE).get(key)
    ) as EraseRecord | undefined;
    if (!rec || !(rec.blob instanceof Blob) || rec.key !== key) return null;
    return rec;
  } catch (e) {
    console.warn('[erase-cache] 读取失败（将重新擦除）', e);
    return null;
  }
}

/**
 * 写入一条擦除缓存，并顺手清掉同一个框的旧条目（拖动会不断产生新键，不清理会
 * 无限增长）。超过全局上限时淘汰最旧的若干条。失败（配额满 / 隐私模式）静默
 * 忽略 —— 缓存写不进去只是下次重擦，不该影响编辑。
 */
export async function saveEraseRecord(rec: EraseRecord): Promise<void> {
  try {
    const db = await openDb();

    const readTx = db.transaction([ERASE_STORE], 'readonly');
    const siblings = await requestToPromise(
      readTx.objectStore(ERASE_STORE).index('regionId').getAllKeys(rec.regionId)
    ) as IDBValidKey[];

    const tx = db.transaction([ERASE_STORE], 'readwrite');
    const store = tx.objectStore(ERASE_STORE);
    for (const k of siblings) if (k !== rec.key) store.delete(k);
    store.put(rec);
    await txDone(tx);

    await pruneEraseRecords(db);
  } catch (e) {
    console.warn('[erase-cache] 写入失败（下次会重新擦除）', e);
  }
}

/** 按 savedAt 从旧到新删除，直到条数落到上限以内。 */
async function pruneEraseRecords(db: IDBDatabase): Promise<void> {
  const countTx = db.transaction([ERASE_STORE], 'readonly');
  const count = await requestToPromise(countTx.objectStore(ERASE_STORE).count());
  let excess = count - ERASE_MAX_ENTRIES;
  if (excess <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([ERASE_STORE], 'readwrite');
    const cursorReq = tx.objectStore(ERASE_STORE).index('savedAt').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || excess <= 0) return; // 走完 / 删够了，交给 tx.oncomplete
      cursor.delete();
      excess--;
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 丢掉某个框的全部擦除缓存（撤回擦除 / 冻结 / 重置时调用 = 用户要求重擦）。 */
export async function deleteEraseRecordsForRegion(regionId: string): Promise<void> {
  try {
    const db = await openDb();
    const readTx = db.transaction([ERASE_STORE], 'readonly');
    const keys = await requestToPromise(
      readTx.objectStore(ERASE_STORE).index('regionId').getAllKeys(regionId)
    ) as IDBValidKey[];
    if (keys.length === 0) return;
    const tx = db.transaction([ERASE_STORE], 'readwrite');
    const store = tx.objectStore(ERASE_STORE);
    for (const k of keys) store.delete(k);
    await txDone(tx);
  } catch (e) {
    console.warn('[erase-cache] 删除失败', e);
  }
}

/** 整体清掉（工作区导入 / 图库整体替换）。 */
export async function clearEraseRecords(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([ERASE_STORE], 'readwrite');
    tx.objectStore(ERASE_STORE).clear();
    await txDone(tx);
  } catch (e) {
    console.warn('[erase-cache] 清空失败', e);
  }
}

/**
 * 会话恢复后清理孤儿：只保留 `imageIds` 里这些图的擦除底图，其余（图被删掉、换过
 * 一批图库、上次没来得及清理的）全部丢掉。
 *
 * 刷新页面本身**不**清空可复用的条目 —— 那正是这份缓存存在的意义；这里删的是
 * 「已经对不上任何图」的部分，避免它们一直占着 IndexedDB（以及让条数上限去背锅）。
 * 传空数组 = 当前图库为空 → 全删。
 */
export async function pruneEraseRecordsExcept(imageIds: readonly string[]): Promise<void> {
  try {
    const keep = new Set(imageIds);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([ERASE_STORE], 'readwrite');
      const store = tx.objectStore(ERASE_STORE);
      // 走 imageId 索引的 key 游标：只需要「索引键 + 主键」，不反序列化 blob。
      const req = store.index('imageId').openKeyCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return; // 走完，交给 tx.oncomplete
        if (!keep.has(String(cursor.key))) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[erase-cache] 清理孤儿失败', e);
  }
}

// -------------------- Glossary book (术语表 v2) --------------------
//
// Lives in META_STORE under its own key, so clearSession() wipes it together
// with the session meta (清空图库 → 术语表一起清).

const GLOSSARY_META_KEY = 'glossary';

interface GlossaryMetaRecord {
  key: string;
  terms: GlossaryTerm[];
  savedAt: number;
}

export async function saveGlossaryBook(terms: GlossaryTerm[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE], 'readwrite');
  const rec: GlossaryMetaRecord = { key: GLOSSARY_META_KEY, terms, savedAt: Date.now() };
  tx.objectStore(META_STORE).put(rec);
  await txDone(tx);
}

/** null = nothing saved. The stored record is sanitized so a corrupted or
 *  stale-shaped entry can never crash the hook. */
export async function loadGlossaryBook(): Promise<GlossaryTerm[] | null> {
  const db = await openDb();
  const tx = db.transaction([META_STORE], 'readonly');
  const rec = await requestToPromise(
    tx.objectStore(META_STORE).get(GLOSSARY_META_KEY)
  ) as GlossaryMetaRecord | undefined;
  if (!rec) return null;
  return sanitizeBook(rec.terms);
}
