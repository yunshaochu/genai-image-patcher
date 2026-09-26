
/**
 * Translation cache stored on the prompt fields (region.customPrompt /
 * image.customPrompt).
 *
 * The AI-generation pipeline reuses the prompt fields for two things at once:
 *
 *   [ user's own instructions ]
 *   ================ (TRANSLATION_CACHE_MARKER)
 *   [ cached translation block ]
 *
 * Everything before the marker belongs to the user (it is appended to the
 * global prompt for the redraw call); everything after it is the cached
 * translation, reused as context on later runs so the translation API is not
 * called twice for the same box.
 *
 * Keeping the format here (instead of inside useImageProcessor) lets the
 * translate stage, the generate stage and the UI all agree on what "this box
 * already has a translation" means.
 */

/**
 * Sentinel string that marks the start of the cached translation block.
 * Deleting this line (or the whole customPrompt) forces a re-translation.
 */
export const TRANSLATION_CACHE_MARKER = '以下是为你提供的图片文字以及文字在图上的坐标/位置数据，请参考：';

export const splitTranslationCache = (prompt?: string): { userPart: string; cached: string | null } => {
    if (!prompt) return { userPart: '', cached: null };
    const idx = prompt.indexOf(TRANSLATION_CACHE_MARKER);
    if (idx < 0) return { userPart: prompt.trim(), cached: null };
    const cached = prompt.slice(idx + TRANSLATION_CACHE_MARKER.length).trim();
    return {
        userPart: prompt.slice(0, idx).trim(),
        cached: cached.length > 0 ? cached : null,
    };
};

export const writeTranslationCache = (userPart: string, translation: string): string => {
    return userPart
        ? `${userPart}\n\n${TRANSLATION_CACHE_MARKER}\n${translation}`
        : `${TRANSLATION_CACHE_MARKER}\n${translation}`;
};

/** True when a prompt field already carries a cached translation block. */
export const hasCachedTranslation = (prompt?: string): boolean =>
    !!splitTranslationCache(prompt).cached;

/**
 * 一次性迁移：把旧版塞在提示词字段里的 marker 译文块拆到独立的译文槽。
 *
 * 译文现在是 `region.customTranslation` / `image.customTranslation`，不再混在
 * 提示词里 —— 提示词框因此永远只放提示词（用户也不会误删 marker 导致缓存失效）。
 * 载入旧会话 / 导入工作状态时调用：有 marker 就拆，没有就原样返回。
 */
export const migratePromptToTranslation = (
    prompt?: string
): { prompt?: string; translation?: string } => {
    const { userPart, cached } = splitTranslationCache(prompt);
    if (!cached) return { prompt };
    return { prompt: userPart || undefined, translation: cached };
};
