
/**
 * 补丁工坊的外部复制（复制图文 / 复制提示词）。
 *
 * The workbench exists for the manual, external-AI workflow: copy the crop into
 * an image editor / chat model, paste the result back. Copying the picture
 * alone was half the story — the model also needs the prompt. The composed text
 * therefore mirrors EXACTLY what the app itself would send (see
 * useImageProcessor's `effectivePrompt`):
 *
 *   全局默认提示词
 *   [图片级专用提示词]        ← 仅全图遮罩行
 *   [该框的提示词]            ← 选区行，按当前意图取对应的槽
 *   [该框的译文]              ← 仅「翻译」意图（擦除 / 自定义绝不拼译文，
 *                              否则模型会去嵌字而不是擦除）
 *
 * The translation is a SEPARATE field now (Region.customTranslation), so it is
 * appended here in the very same shape the redraw pipeline uses
 * (TRANSLATION_CACHE_MARKER + text) — a redraw model needs it to know which
 * Chinese text to draw.
 *
 * Clipboard notes:
 * - `navigator.clipboard.write` accepts several MIME types at once, so one
 *   write can carry image + text. Paste targets differ in what they consume
 *   (rich editors take both; chat UIs usually attach the image and may ignore
 *   the text), which is why the UI also offers a plain-text button.
 * - Firefox / older browsers reject multi-type (or any) ClipboardItem writes —
 *   every step degrades instead of throwing: image+text → image → text.
 */

import { AppConfig } from '../types';
import { TRANSLATION_CACHE_MARKER } from './translationCache';

/**
 * Compose the prompt the app would send for this target.
 * Regions without a prompt of their own simply contribute nothing.
 *
 * `prompts.translation` is the box's / image's 本框译文: it is only ever passed
 * when the target's effective redraw intent is 'translate', and it is appended
 * in the exact shape `useImageProcessor` builds for the redraw API.
 */
export const buildWorkbenchPrompt = (
    config: AppConfig,
    prompts: { imagePrompt?: string; regionPrompt?: string; translation?: string }
): string => {
    const parts: string[] = [];
    const global = (config.prompt ?? '').trim();
    if (global) parts.push(global);

    // A region row copies its own box; the full-image row copies the
    // image-level prompt. Pasted VERBATIM.
    const own = (prompts.regionPrompt ?? prompts.imagePrompt ?? '').trim();
    if (own) parts.push(own);

    const translation = (prompts.translation ?? '').trim();
    if (translation) parts.push(`${TRANSLATION_CACHE_MARKER}\n${translation}`);

    return parts.join('\n\n');
};

export type CopyOutcome = 'image+text' | 'image' | 'text' | 'failed';

/** Plain-text clipboard write. Returns false when the browser refuses. */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        console.error('Clipboard text write failed', e);
        return false;
    }
};

/**
 * Write the image AND the prompt in one clipboard operation, degrading
 * gracefully: image+text → image only → text only.
 */
export const copyImageAndTextToClipboard = async (
    imageUrl: string,
    text: string
): Promise<CopyOutcome> => {
    let blob: Blob | null = null;
    try {
        const res = await fetch(imageUrl);
        blob = await res.blob();
    } catch (e) {
        console.error('Failed to read the crop for copying', e);
    }

    const canWriteItems =
        typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;

    if (blob && canWriteItems) {
        const mimeType = blob.type || 'image/png';
        if (text.trim()) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        [mimeType]: blob,
                        'text/plain': new Blob([text], { type: 'text/plain' }),
                    }),
                ]);
                return 'image+text';
            } catch (e) {
                console.warn('浏览器不支持图文同时复制，退化为只复制图片', e);
            }
        }
        try {
            await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
            return 'image';
        } catch (e) {
            console.error('Clipboard image write failed', e);
        }
    }

    return (await copyTextToClipboard(text)) ? 'text' : 'failed';
};
