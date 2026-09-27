import { AppConfig, ApiProfile } from '../types';

/**
 * Export / import of the whole user config (the object `useConfig` keeps in
 * localStorage) as a JSON file, so settings survive a machine swap or a
 * cleared browser profile.
 *
 * Only AppConfig is exported — the gallery / editing session lives in
 * IndexedDB and is deliberately left out (it holds full-size images).
 *
 * Imports are merged onto the current config key-by-key and every value is
 * type-checked against what is already there, so a hand-edited or
 * version-skewed file can never inject an unknown key or crash a renderer
 * (a preset array is item-by-item validated for the same reason).
 */

export const CONFIG_EXPORT_KIND = 'genai-patcher-config';
export const CONFIG_EXPORT_VERSION = 1;

export interface ConfigExportPayload {
  app: 'genai-patcher';
  kind: typeof CONFIG_EXPORT_KIND;
  version: number;
  exportedAt: string;
  config: AppConfig;
}

export interface ConfigImportResult {
  /** Current config with every accepted key replaced. */
  config: AppConfig;
  /** How many keys were taken from the file. */
  appliedCount: number;
  /** Keys present in the file but rejected (wrong type / drifted schema). */
  skippedKeys: string[];
  /** `exportedAt` of the file, when it carries one. */
  exportedAt?: string;
}

export type ConfigImportError = 'invalid-json' | 'not-an-object' | 'no-usable-keys';

/** String-tagged union on purpose: this project compiles without
 *  `strictNullChecks`, where a boolean literal discriminant does not narrow. */
export type ConfigImportOutcome =
  | { status: 'ok'; result: ConfigImportResult }
  | { status: 'error'; error: ConfigImportError };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const fileStamp = (): string =>
  new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '');

export const buildExportPayload = (config: AppConfig): ConfigExportPayload => ({
  app: 'genai-patcher',
  kind: CONFIG_EXPORT_KIND,
  version: CONFIG_EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  config,
});

/** Serialise + download the config; returns the file name used. */
export const downloadConfigExport = (config: AppConfig): string => {
  const payload = buildExportPayload(config);
  const fileName = `genai-patcher-config-${fileStamp()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
};

/** Saved API presets get a field-by-field check: the switcher renders `name`
 *  directly, so a stray object there would take the panel down. */
const sanitizeProfileList = (value: unknown): ApiProfile[] => {
  if (!Array.isArray(value)) return [];
  const out: ApiProfile[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const { id, name } = item;
    if (typeof id !== 'string' || !id || typeof name !== 'string') continue;
    out.push({
      id,
      name,
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      model: typeof item.model === 'string' ? item.model : '',
    });
  }
  return out;
};

/** Enum-ish fields are whitelisted: `valueFits` only checks `typeof`, so a
 *  hand-edited file could otherwise smuggle in e.g. `language: "fr"` and take
 *  the whole i18n lookup down with it. */
const ENUM_FIELDS: Record<string, readonly string[]> = {
  provider: ['openai', 'gemini'],
  openaiImageEndpointMode: ['chat', 'edit'],
  theme: ['light', 'dark', 'ocean', 'rose', 'forest'],
  language: ['zh', 'en'],
  processingMode: ['api', 'manual', 'editor'],
  performanceMode: ['unlimited', 'balanced'],
  executionMode: ['concurrent', 'serial'],
  generationRegionSource: ['text', 'bubble'],
  defaultRedrawIntent: ['translate', 'erase', 'custom'],
};

/** Loose structural check: same kind of value as the one already in config.
 *  (Nullable string ids accept string | null, arrays accept arrays, numbers
 *  must be finite — that is enough to keep a corrupt file from breaking UI.) */
const valueFits = (currentValue: unknown, next: unknown): boolean => {
  if (Array.isArray(currentValue)) return Array.isArray(next);
  if (currentValue === null) return next === null || typeof next === 'string';
  if (typeof currentValue === 'number') return typeof next === 'number' && Number.isFinite(next);
  if (typeof currentValue === 'boolean') return typeof next === 'boolean';
  if (typeof currentValue === 'string') return typeof next === 'string';
  return false;
};

/** Merge an imported (already parsed, unvalidated) config onto the current one.
 *  Only keys that exist in the current config are considered, so legacy keys
 *  from an older export are dropped instead of lingering in the config. */
export const mergeImportedConfig = (
  current: AppConfig,
  imported: Record<string, unknown>,
): ConfigImportResult => {
  const currentRecord = current as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const skippedKeys: string[] = [];

  for (const key of Object.keys(current)) {
    if (!(key in imported)) continue;
    const next = imported[key];

    if (key === 'imageApiProfiles' || key === 'translationApiProfiles') {
      if (Array.isArray(next)) patch[key] = sanitizeProfileList(next);
      else skippedKeys.push(key);
      continue;
    }

    const allowed = ENUM_FIELDS[key];
    if (allowed && !(typeof next === 'string' && allowed.includes(next))) {
      skippedKeys.push(key);
      continue;
    }

    if (valueFits(currentRecord[key], next)) patch[key] = next;
    else skippedKeys.push(key);
  }

  return {
    config: { ...current, ...patch } as AppConfig,
    appliedCount: Object.keys(patch).length,
    skippedKeys,
  };
};

/** Parse a file the user picked. Accepts the wrapped export format as well as
 *  a bare AppConfig object (hand-trimmed files), then merges it. */
export const readConfigExport = (text: string, current: AppConfig): ConfigImportOutcome => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'error', error: 'invalid-json' };
  }

  const raw = isPlainObject(parsed) && isPlainObject(parsed.config) ? parsed.config : parsed;
  if (!isPlainObject(raw)) return { status: 'error', error: 'not-an-object' };

  const result = mergeImportedConfig(current, raw);
  if (result.appliedCount === 0) return { status: 'error', error: 'no-usable-keys' };

  const exportedAt = isPlainObject(parsed) && typeof parsed.exportedAt === 'string'
    ? parsed.exportedAt
    : undefined;

  return { status: 'ok', result: { ...result, exportedAt } };
};
