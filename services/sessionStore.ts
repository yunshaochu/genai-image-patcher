import { Region, UploadedImage, ImageHistoryState, RedrawIntent, GlossaryTerm } from '../types';
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
const DB_VERSION = 1;
const IMAGE_STORE = 'images';
const META_STORE = 'meta';
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
  const tx = db.transaction([IMAGE_STORE, META_STORE], 'readwrite');
  tx.objectStore(IMAGE_STORE).clear();
  tx.objectStore(META_STORE).clear();
  await txDone(tx);
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
