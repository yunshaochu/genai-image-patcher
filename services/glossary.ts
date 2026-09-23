
/**
 * Project-wide term glossary (术语表).
 *
 * Cross-page naming consistency is the whole point of translating a manga:
 * once 「ルフィ」 has become 「路飞」, every later page must say 路飞 too. The
 * glossary is therefore kept as a flat list of term pairs that is
 *
 *  1. fed into EVERY translation prompt (so the model reuses existing terms),
 *  2. extended by the translation response itself.
 *
 * Because the terms travel in the same call as the translation, the glossary
 * stays in lockstep with the translated pages without a second API call per
 * image. A response that reports nothing new leaves the glossary untouched
 * ("没什么新东西也可以不更新").
 *
 * The response contract is JSON:
 *
 *   { "translation": "...", "glossary": [{"source":"…","target":"…"}] }
 *
 * JSON is used instead of a marker block because models reliably follow a
 * structural output request, while the previous "append `=== 术语表 ===`"
 * instruction was silently ignored (the user's own translation prompt specifies
 * a markdown `原文 ——> 译文` format, and models just kept following it, which is
 * exactly how the glossary stayed empty). The old marker format is still
 * accepted as a fallback, and so are arrow / colon separated term rows.
 *
 * Storage format of one glossary entry stays human-editable:
 *   `原文 | 译文 | 备注`   (备注 optional; the first column is the key)
 */

/** Header the (legacy) model output used before the JSON contract. */
export const GLOSSARY_MARKER = '=== 术语表 ===';

/** Hard cap on glossary rows — keeps every later prompt bounded on huge
 *  projects (oldest entries are dropped first). */
export const MAX_GLOSSARY_ENTRIES = 400;

/** Separators accepted inside a term row, most specific first. */
const TERM_ROW_SPLIT = /\s*(?:\||｜|——>|-->|->|→|=>|＝|：|:|\t)\s*/;

/** Identity key of a term row: the first column, lower-cased. */
export const termKeyOf = (line: string): string => {
  const first = line.replace(/^\|/, '').split(/[|｜]/)[0] ?? '';
  return first.trim().toLowerCase();
};

const splitTermRow = (line: string): string[] =>
  line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .replace(/[｜]/g, '|')
    .split(TERM_ROW_SPLIT)
    .map(p => p.replace(/^[*_`"'「『]+|[*_`"'」』]+$/g, '').trim())
    .filter((p, i, arr) => !(p === '' && i === arr.length - 1));

const isHeaderRow = (row: string): boolean => {
  const hasSource = /(原文|原词|原语言|source|term)/i.test(row);
  const hasTarget = /(译文|译名|中文|翻译|target|meaning)/i.test(row);
  return hasSource && hasTarget;
};

/** Normalise one raw line into `原文 | 译文 | 备注`, or null when it is not a
 *  term row (separator / header / prose). Strips bullets and blockquote (`>`)
 *  prefixes, because models often keep the prompt's quoting in their answer. */
const normalizeTermLine = (raw: string): string | null => {
  let line = raw
    .trim()
    .replace(/^[>\s]*[-*•+]?\s*/, '')
    .replace(/\s*>$/, '')
    .trim();
  if (!line) return null;
  if (/^[|\-:\s]+$/.test(line)) return null;       // markdown table separator
  const parts = splitTermRow(line);
  if (parts.length < 2) return null;               // not a pair
  const [source, target, note] = parts;
  if (!source || !target) return null;
  const joined = note ? `${source} | ${target} | ${note}` : `${source} | ${target}`;
  if (isHeaderRow(joined)) return null;
  return joined.replace(/\s+/g, ' ');
};

/** Normalise a whole term block (legacy `=== 术语表 ===` payload). */
export const cleanTermLines = (raw: string): string => {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const clean = normalizeTermLine(line);
    if (clean) out.push(clean);
  }
  return out.join('\n');
};

/** A line that is essentially just the legacy glossary marker. */
const isMarkerLine = (line: string): boolean => {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (!/术语表|glossary/i.test(t)) return false;
  const stripped = t
    .replace(/[=\-#*>+|【】[\]（）()\s:：。.]/g, '')
    .replace(/术语表|glossary/gi, '');
  return stripped.length === 0;
};

// =====================================================================
// JSON CONTRACT
// =====================================================================

/** Balance-aware `{...}` scanner (ignores braces inside strings). */
const findBalancedObject = (s: string, start: number): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * Models frequently emit raw newlines / tabs inside JSON strings, which is
 * invalid JSON but trivially repairable. Escape them (only inside strings).
 */
const escapeRawControlChars = (s: string): string => {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
};

const tryJsonParse = (candidate: string): any | null => {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(escapeRawControlChars(candidate));
    } catch {
      return null;
    }
  }
};

const coerceTermRows = (value: any): string => {
  if (typeof value === 'string') return cleanTermLines(value);
  if (!Array.isArray(value)) return '';
  const rows: string[] = [];
  for (const item of value) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const clean = normalizeTermLine(item);
      if (clean) rows.push(clean);
      continue;
    }
    if (typeof item !== 'object') continue;
    const source = item.source ?? item.原文 ?? item.term ?? item.src ?? item.key;
    const target = item.target ?? item.译文 ?? item.translation ?? item.dst ?? item.value;
    const note = item.note ?? item.备注 ?? item.desc ?? item.remark;
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    if (!source.trim() || !target.trim()) continue;
    const joined = typeof note === 'string' && note.trim()
      ? `${source.trim()} | ${target.trim()} | ${note.trim()}`
      : `${source.trim()} | ${target.trim()}`;
    const clean = normalizeTermLine(joined);
    if (clean) rows.push(clean);
  }
  return rows.join('\n');
};

/** Recognise a parsed JSON object as the translation payload. */
const normalizeTranslationPayload = (parsed: any): { text: string; terms: string } | null => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const text = parsed.translation ?? parsed.text ?? parsed.译文 ?? parsed.result;
  if (typeof text !== 'string') return null;
  const terms = coerceTermRows(
    parsed.glossary ?? parsed.terms ?? parsed.termList ?? parsed.术语表 ?? parsed.术语
  );
  return { text: text.trim(), terms };
};

/** Which contract the answered response actually followed (for diagnostics). */
export type TranslationFormat = 'json' | 'salvaged' | 'marker' | 'plain';

const unescapeJsonString = (s: string): string =>
  s.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t')
   .replace(/\\"/g, '"').replace(/\\\\/g, '\\');

const salvageJsonPayload = (cleaned: string): { text: string; terms: string } | null => {
  const textMatch = cleaned.match(
    /"translation"\s*:\s*"((?:[^"\\]|\\.)*)"/s
  ) ?? cleaned.match(/"(?:text|译文|result)"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (!textMatch) return null;

  const pairRe = /"(?:source|原文|term)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"(?:target|译文|translation)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const noteRe = /"(?:note|备注|desc)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
  const rows: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(cleaned)) !== null) {
    const note = noteRe.exec(cleaned.slice(m.index, m.index + 400));
    const joined = note
      ? `${unescapeJsonString(m[1])} | ${unescapeJsonString(m[2])} | ${unescapeJsonString(note[1])}`
      : `${unescapeJsonString(m[1])} | ${unescapeJsonString(m[2])}`;
    const clean = normalizeTermLine(joined);
    if (clean) rows.push(clean);
  }

  return {
    text: unescapeJsonString(textMatch[1]).trim(),
    terms: rows.join('\n'),
  };
};

/**
 * Split a translation response into the translation itself and the term pairs
 * the model reported. Handles, in order:
 *  1. the JSON contract above (even with prose around it / a code fence /
 *     raw newlines inside the strings),
 *  2. a half-broken JSON answer (regex salvage),
 *  3. the legacy `=== 术语表 ===` marker block,
 *  4. a plain markdown answer (→ all text, no terms).
 *
 * `format` tells the caller which branch was used, so "the model ignored the
 * JSON contract" can be diagnosed without logging on every legitimately
 * term-free page.
 */
export const parseTranslationWithTerms = (
  content: string
): { text: string; terms: string; format: TranslationFormat } => {
  const raw = (content ?? '').trim();
  const withFormat = (format: TranslationFormat, payload: { text: string; terms: string }) => ({
    ...payload,
    format,
  });

  const cleaned = raw.replace(/```[a-zA-Z]*/g, '');
  let searchFrom = 0;
  while (true) {
    const start = cleaned.indexOf('{', searchFrom);
    if (start === -1) break;
    const candidate = findBalancedObject(cleaned, start);
    if (!candidate) break;
    const payload = normalizeTranslationPayload(tryJsonParse(candidate));
    if (payload) return withFormat('json', payload);
    searchFrom = start + 1;
  }

  // Half-broken JSON: pull the two fields out textually rather than caching a
  // raw JSON blob as the "translation".
  if (cleaned.includes('"translation"') || cleaned.includes('"glossary"')) {
    const salvaged = salvageJsonPayload(cleaned);
    if (salvaged) return withFormat('salvaged', salvaged);
  }

  // Legacy marker block.
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isMarkerLine(lines[i])) continue;
    return withFormat('marker', {
      text: lines.slice(0, i).join('\n').trim(),
      terms: cleanTermLines(lines.slice(i + 1).join('\n')),
    });
  }

  return withFormat('plain', { text: raw, terms: '' });
};

// =====================================================================
// MERGE / PROMPT
// =====================================================================

/**
 * Merge newly reported terms into the glossary. Existing keys win (the first
 * spelling sticks), so re-reporting a known term is a no-op and the result is
 * byte-identical — callers can cheaply test "did anything change?".
 */
export const mergeGlossary = (existing: string, incoming: string): string => {
  const rows = existing
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const r of rows) {
    const key = termKeyOf(r);
    if (key) seen.add(key);
  }

  const added: string[] = [];
  for (const raw of incoming.split('\n')) {
    const line = normalizeTermLine(raw);
    if (!line) continue;
    const key = termKeyOf(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(line);
  }
  if (added.length === 0) return existing;

  const merged = [...rows, ...added];
  return merged.length > MAX_GLOSSARY_ENTRIES
    ? merged.slice(merged.length - MAX_GLOSSARY_ENTRIES).join('\n')
    : merged.join('\n');
};

/** Non-empty glossary rows (for the settings UI counter). */
export const countGlossaryEntries = (glossary?: string): number =>
  (glossary ?? '').split('\n').filter(l => l.trim()).length;

/** The glossary rendered as a JSON array for the prompt (falls back to the raw
 *  text when the user typed something that isn't a term list). */
export const glossaryToJson = (glossary?: string): string => {
  const rows = (glossary ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(normalizeTermLine)
    .filter((l): l is string => !!l)
    .map(line => {
      const [source, target, note] = line.split(' | ');
      return note ? { source, target, note } : { source, target };
    });
  if (rows.length === 0) return (glossary ?? '').trim() || '[]';
  return JSON.stringify(rows);
};

/**
 * Instruction appended to every translation prompt while the glossary feature
 * is on: reuse the known terms, then answer with the JSON payload carrying the
 * translation plus the new/corrected terms.
 */
export const buildGlossaryInstruction = (glossary: string): string => {
  const known = glossaryToJson(glossary);
  return `
> **术语表（跨图一致性，强制遵守）**
> 本项目已确定的术语（JSON 数组，source=原文，target=译文，note=可选备注）：
> ${known}
> 翻译时若命中上述术语，必须原样沿用其 target，禁止另创译名。
>
> **输出格式（覆盖前面的格式说明，最高优先级）**：
> 你的本次回复必须是一个 JSON 对象，不要 markdown 代码块、不要任何解释文字，结构如下：
> {"translation":"<翻译正文>","glossary":[{"source":"<原文术语>","target":"<译文>","note":"<可选备注>"}]}
> * translation：把前面要求的翻译结果**完整**放在这里（保留原有排版与换行，用 \\n 转义）；只放翻译正文，不要把术语表内容写进去。
> * glossary：只填本次新识别、或需要修正的专有名词（人名/地名/组织/招式名/固定译法）；已知术语不要重复上报；没有任何新增就填 []，不要编造。
> * 必须是合法 JSON（字符串内的换行写成 \\n），否则本次结果会被判为失败。`;
};
