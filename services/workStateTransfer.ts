import JSZip from 'jszip';
import { AppConfig, GlossaryTerm, Region, UploadedImage } from '../types';
import {
  ImageRecord,
  PersistableUrl,
  RegionRecord,
  deserializeImage,
  serializeImage,
} from './sessionStore';
import { buildExportPayload, mergeImportedConfig } from './configTransfer';
import { sanitizeBook, serializeBook } from './glossaryBook';

/**
 * Whole-work-state backup: gallery images + the full editing session (regions,
 * editor / AI-redraw data) + the settings, packed into one ZIP.
 *
 * Unlike the IndexedDB session mirror (sessionStore.ts, browser-local and
 * auto-managed) this is a portable file the user can keep, move to another
 * machine and re-import to restore the working state exactly.
 *
 * Layout:
 *   manifest.json   – everything except the binary payloads (order, fold state,
 *                     region scalars, and per-blob references)
 *   config.json     – the AppConfig export (same payload as 导出配置)
 *   blobs/<id>/...  – original file, preview, thumbnail, results and every
 *                     region's processed patch / restore mask / brush layer
 *
 * Blob fields go in as real ZIP entries; data: URLs are decoded to entries too
 * (they can be large) while http(s): URLs — external resources — stay inline.
 * Import reuses sessionStore's ImageRecord / serializeImage / deserializeImage,
 * so the round-trip and the browser-local session stay byte-for-byte compatible.
 */

export const WORKSTATE_KIND = 'genai-patcher-workstate';
export const WORKSTATE_VERSION = 1;

const MANIFEST_NAME = 'manifest.json';
const CONFIG_NAME = 'config.json';
/** 术语表 v2（glossaryBook.ts 的信封格式，与单独导出同一个文件）。 */
const GLOSSARY_NAME = 'glossary.json';

/** A persisted URL in the manifest: either a ZIP entry path or a kept URL. */
type ManifestRef = { type: 'file'; path: string } | { type: 'url'; url: string };

interface WorkStateRegionEntry {
  scalars: Omit<Region, 'processedImageUrl' | 'restoreMaskUrl' | 'editorBrushUrl'>;
  processed?: ManifestRef;
  restoreMask?: ManifestRef;
  editorBrush?: ManifestRef;
}

interface WorkStateImageEntry {
  id: string;
  fileName: string;
  fileType: string;
  originalWidth: number;
  originalHeight: number;
  isSkipped?: boolean;
  customPrompt?: string;
  redrawIntent?: ImageRecord['redrawIntent'];
  customPromptErase?: string;
  customPromptFree?: string;
  customTranslation?: string;
  appliedAsOriginal?: boolean;
  original: ManifestRef;
  preview?: ManifestRef;
  thumbnail?: ManifestRef;
  finalResult?: ManifestRef;
  fullAi?: ManifestRef;
  regions: WorkStateRegionEntry[];
}

interface WorkStateManifest {
  app: 'genai-patcher';
  kind: typeof WORKSTATE_KIND;
  version: number;
  exportedAt: string;
  selectedImageId: string | null;
  images: WorkStateImageEntry[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const fileStamp = (): string =>
  new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '');

const extFromFileName = (name: string): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? `.${m[1].toLowerCase()}` : '.png';
};

/** Store one persisted URL: Blobs → a ZIP entry, data: URLs decoded to an
 *  entry, everything else (http/https) kept as an inline URL. */
const writePersistable = async (
  zip: JSZip,
  value: PersistableUrl,
  path: string,
): Promise<ManifestRef | undefined> => {
  if (!value) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      try {
        const blob = await (await fetch(value)).blob();
        zip.file(path, blob);
        return { type: 'file', path };
      } catch {
        return { type: 'url', url: value };
      }
    }
    return { type: 'url', url: value };
  }
  zip.file(path, value);
  return { type: 'file', path };
};

/** Inverse of writePersistable — back to Blob / URL string. */
const readPersistable = async (zip: JSZip, ref?: ManifestRef): Promise<PersistableUrl> => {
  if (!ref) return undefined;
  if (ref.type === 'url') return ref.url;
  const entry = zip.file(ref.path);
  if (!entry) return undefined;
  return await entry.async('blob');
};

const triggerDownload = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Pack every image (its current editing state) plus the settings into a ZIP
 *  and download it. Returns the file name used.
 *
 *  `glossaryTerms`（术语表 v2）提供时写入 glossary.json —— 哪怕是空数组也写，
 *  这样导入方能区分「旧包没有术语表」（不动现有术语表）和「这个作品的术语
 *  表就是空的」（还原为空）。 */
export async function downloadWorkStateZip(
  images: UploadedImage[],
  selectedImageId: string | null,
  config: AppConfig,
  onProgress?: (done: number, total: number) => void,
  glossaryTerms?: GlossaryTerm[],
): Promise<string> {
  const zip = new JSZip();
  zip.file(CONFIG_NAME, JSON.stringify(buildExportPayload(config), null, 2));
  if (glossaryTerms) {
    zip.file(GLOSSARY_NAME, JSON.stringify(serializeBook(glossaryTerms), null, 2));
  }

  const entries: WorkStateImageEntry[] = [];
  let done = 0;

  for (const img of images) {
    const rec = await serializeImage(img);
    const dir = `blobs/${rec.id}`;

    const originalRef = await writePersistable(zip, rec.file, `${dir}/original${extFromFileName(img.file.name)}`);

    const regions: WorkStateRegionEntry[] = [];
    for (const r of rec.regions) {
      const { processed, restoreMask, editorBrush, ...scalars } = r;
      regions.push({
        scalars,
        processed: await writePersistable(zip, processed, `${dir}/region-${r.id}-processed.png`),
        restoreMask: await writePersistable(zip, restoreMask, `${dir}/region-${r.id}-mask.png`),
        editorBrush: await writePersistable(zip, editorBrush, `${dir}/region-${r.id}-brush.png`),
      });
    }

    entries.push({
      id: rec.id,
      fileName: img.file.name,
      fileType: img.file.type,
      originalWidth: rec.originalWidth,
      originalHeight: rec.originalHeight,
      isSkipped: rec.isSkipped,
      customPrompt: rec.customPrompt,
      redrawIntent: rec.redrawIntent,
      customPromptErase: rec.customPromptErase,
      customPromptFree: rec.customPromptFree,
      customTranslation: rec.customTranslation,
      appliedAsOriginal: rec.appliedAsOriginal,
      original: originalRef!,
      preview: await writePersistable(zip, rec.preview, `${dir}/preview.png`),
      thumbnail: await writePersistable(zip, rec.thumbnail, `${dir}/thumbnail.png`),
      finalResult: await writePersistable(zip, rec.finalResult, `${dir}/final.png`),
      fullAi: await writePersistable(zip, rec.fullAi, `${dir}/fullai.png`),
      regions,
    });

    done += 1;
    onProgress?.(done, images.length);
  }

  const manifest: WorkStateManifest = {
    app: 'genai-patcher',
    kind: WORKSTATE_KIND,
    version: WORKSTATE_VERSION,
    exportedAt: new Date().toISOString(),
    selectedImageId,
    images: entries,
  };
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: 'blob', streamFiles: true });
  const fileName = `genai-workstate-${fileStamp()}.zip`;
  triggerDownload(blob, fileName);
  return fileName;
}

export type WorkStateImportError =
  | 'not-a-zip'
  | 'bad-manifest'
  | 'version-unsupported'
  | 'empty';

export type WorkStateImportOutcome =
  | {
      status: 'ok';
      images: UploadedImage[];
      selectedImageId: string | null;
      /** Merged config, present only when the package carried usable settings. */
      config?: AppConfig;
      configAppliedCount: number;
      /** 术语表 v2，仅当包里有 glossary.json 时存在（空数组也是有效还原）。 */
      glossary?: GlossaryTerm[];
    }
  | { status: 'error'; error: WorkStateImportError };

/** Locate manifest.json at the archive root or under a wrapping folder. */
const findManifestEntry = (zip: JSZip) => {
  const direct = zip.file(MANIFEST_NAME);
  if (direct) return direct;
  const key = Object.keys(zip.files).find((k) => k.endsWith(MANIFEST_NAME));
  return key ? zip.file(key) : null;
};

/** Read a work-state ZIP back into a ready-to-install gallery (+ merged config). */
export async function readWorkStateZip(
  file: File,
  currentConfig: AppConfig,
): Promise<WorkStateImportOutcome> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    return { status: 'error', error: 'not-a-zip' };
  }

  const manifestEntry = findManifestEntry(zip);
  if (!manifestEntry) return { status: 'error', error: 'bad-manifest' };

  let manifest: WorkStateManifest;
  try {
    const parsed = JSON.parse(await manifestEntry.async('string'));
    if (!isPlainObject(parsed) || parsed.kind !== WORKSTATE_KIND || !Array.isArray(parsed.images)) {
      return { status: 'error', error: 'bad-manifest' };
    }
    manifest = parsed as unknown as WorkStateManifest;
  } catch {
    return { status: 'error', error: 'bad-manifest' };
  }

  if (typeof manifest.version === 'number' && manifest.version > WORKSTATE_VERSION) {
    return { status: 'error', error: 'version-unsupported' };
  }

  const images: UploadedImage[] = [];
  for (const entry of manifest.images) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !isPlainObject(entry.original)) continue;

    const originalValue = await readPersistable(zip, entry.original as ManifestRef);
    if (!originalValue) continue;
    // An external URL original (rare) has to be fetched before it can become a File.
    const originalBlob = typeof originalValue === 'string'
      ? await fetch(originalValue).then((r) => r.blob()).catch(() => null)
      : originalValue;
    if (!originalBlob) continue;

    const fileName = typeof entry.fileName === 'string' && entry.fileName ? entry.fileName : 'image.png';
    const fileBlob = new File(
      [originalBlob],
      fileName,
      { type: typeof entry.fileType === 'string' && entry.fileType ? entry.fileType : originalBlob.type || 'application/octet-stream' },
    );

    const regions: RegionRecord[] = [];
    const entryRegions = Array.isArray(entry.regions) ? entry.regions : [];
    for (const r of entryRegions) {
      if (!isPlainObject(r) || !isPlainObject(r.scalars) || typeof r.scalars.id !== 'string') continue;
      const [processed, restoreMask, editorBrush] = await Promise.all([
        readPersistable(zip, r.processed as ManifestRef),
        readPersistable(zip, r.restoreMask as ManifestRef),
        readPersistable(zip, r.editorBrush as ManifestRef),
      ]);
      regions.push({ ...(r.scalars as RegionRecord), processed, restoreMask, editorBrush });
    }

    const record: ImageRecord = {
      id: entry.id,
      file: fileBlob,
      preview: await readPersistable(zip, entry.preview as ManifestRef),
      thumbnail: await readPersistable(zip, entry.thumbnail as ManifestRef),
      finalResult: await readPersistable(zip, entry.finalResult as ManifestRef),
      fullAi: await readPersistable(zip, entry.fullAi as ManifestRef),
      originalWidth: typeof entry.originalWidth === 'number' ? entry.originalWidth : 0,
      originalHeight: typeof entry.originalHeight === 'number' ? entry.originalHeight : 0,
      isSkipped: !!entry.isSkipped,
      customPrompt: typeof entry.customPrompt === 'string' ? entry.customPrompt : undefined,
      redrawIntent: entry.redrawIntent,
      customPromptErase: typeof entry.customPromptErase === 'string' ? entry.customPromptErase : undefined,
      customPromptFree: typeof entry.customPromptFree === 'string' ? entry.customPromptFree : undefined,
      customTranslation: typeof entry.customTranslation === 'string' ? entry.customTranslation : undefined,
      appliedAsOriginal: !!entry.appliedAsOriginal,
      regions,
    };

    images.push(deserializeImage(record));
  }

  if (images.length === 0) return { status: 'error', error: 'empty' };

  const selectedImageId =
    typeof manifest.selectedImageId === 'string' && images.some((i) => i.id === manifest.selectedImageId)
      ? manifest.selectedImageId
      : images[0].id;

  // Settings travel with the package (so a restore is truly complete) but are
  // merged through the same validated path as 导入配置 — unknown / type-drifted
  // keys from an older or hand-edited file can never reach the config.
  let config: AppConfig | undefined;
  let configAppliedCount = 0;
  const configEntry = zip.file(CONFIG_NAME);
  if (configEntry) {
    try {
      const parsed = JSON.parse(await configEntry.async('string'));
      const raw = isPlainObject(parsed) && isPlainObject(parsed.config) ? parsed.config : parsed;
      if (isPlainObject(raw)) {
        const merged = mergeImportedConfig(currentConfig, raw);
        if (merged.appliedCount > 0) {
          config = merged.config;
          configAppliedCount = merged.appliedCount;
        }
      }
    } catch { /* settings are optional — a bad config.json must not fail the restore */ }
  }

  // 术语表同样随包走：旧包没有这个文件 → undefined（导入方不动现有术语表）；
  // 有但内容坏了 → 跳过，不让一颗老鼠屎坏掉整个还原。
  let glossary: GlossaryTerm[] | undefined;
  const glossaryEntry = zip.file(GLOSSARY_NAME);
  if (glossaryEntry) {
    try {
      glossary = sanitizeBook(JSON.parse(await glossaryEntry.async('string'))) ?? undefined;
    } catch { /* glossary is optional */ }
  }

  return { status: 'ok', images, selectedImageId, config, configAppliedCount, glossary };
}
