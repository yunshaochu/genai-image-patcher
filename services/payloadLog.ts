import { AppConfig } from '../types';

/**
 * In-memory log of the images ACTUALLY sent to the AI.
 *
 * The pipeline transforms the artwork before every request — it crops to the
 * selection, paints the non-selected (or selected) areas white, pads to a
 * square, re-encodes to WebP, and in the editor flow overlays numbered boxes.
 * None of that is visible on the canvas, so "what did the model actually see"
 * had no answer at all. This keeps the last few payloads so the user can look.
 *
 * Deliberately memory-only, capped and never persisted: these are page-sized
 * images, and they are the user's own artwork.
 *
 * NOTE on ownership: the pipeline revokes its Object URLs as soon as the
 * request finishes, so a record cannot hold those references — it copies the
 * bytes into a Blob it owns and revokes its own URL on eviction.
 */

export type PayloadPhase = 'redraw' | 'translate' | 'editorTranslate';

/** What happened to the image on its way out, in order. */
export type PayloadTransform =
    | 'crop'            // only the selection's slice leaves
    | 'full-page'       // the whole page leaves
    | 'mask'            // everything outside the selection painted white
    | 'inverted-mask'   // the selection itself painted white
    | 'context'         // a masked full page sent alongside a crop
    | 'square-fill'     // padded to a square with a blurred background
    | 'compress'        // re-encoded to WebP at a target size
    | 'annotate';       // numbered boxes drawn over the page

export interface PayloadRecord {
    id: string;
    /** Epoch ms — used for ordering (concurrent requests finish out of order). */
    at: number;
    phase: PayloadPhase;
    imageId: string;
    imageName: string;
    regionIds: string[];
    transforms: PayloadTransform[];
    /** Model the payload was addressed to. */
    model: string;
    prompt: string;
    /** Target size of the re-encode, when one happened. */
    compressionTargetKB?: number;
    /** Size of the bytes that left the machine. */
    bytes: number;
    /** Display URL of the sent image (owned by this module). */
    imageUrl: string;
    /** Companion image (e.g. the masked context page), when one was sent. */
    extra?: { url: string; label: string; bytes: number } | null;
}

const MAX_RECORDS = 12;

let records: PayloadRecord[] = [];
const listeners = new Set<() => void>();

const emit = () => { listeners.forEach(listener => listener()); };

export const subscribePayloadLog = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const getPayloadRecords = (): PayloadRecord[] => records;

const releaseRecord = (record: PayloadRecord) => {
    URL.revokeObjectURL(record.imageUrl);
    if (record.extra) URL.revokeObjectURL(record.extra.url);
};

export const clearPayloadLog = (): void => {
    records.forEach(releaseRecord);
    records = [];
    emit();
};

/** Copy a pipeline URL into a Blob we own (works for blob: and data: URLs). */
const copyToBlob = async (url: string): Promise<Blob | null> => {
    try {
        const response = await fetch(url);
        return await response.blob();
    } catch {
        return null;
    }
};

export interface PayloadInput {
    config: AppConfig;
    phase: PayloadPhase;
    imageId?: string;
    imageName?: string;
    regionIds?: string[];
    transforms: PayloadTransform[];
    prompt: string;
    /** The exact image handed to the API (blob: or data: URL). */
    sentUrl: string;
    /** Companion image sent with the same request. */
    extra?: { url: string; label: string } | null;
}

/**
 * Fire-and-forget by design: this is diagnostics, so it must never add latency
 * to a request or surface an error of its own.
 */
export const recordPayload = (input: PayloadInput): void => {
    const at = Date.now();
    void (async () => {
        try {
            const blob = await copyToBlob(input.sentUrl);
            if (!blob) return;

            let extra: PayloadRecord['extra'] = null;
            if (input.extra) {
                const extraBlob = await copyToBlob(input.extra.url);
                if (extraBlob) {
                    extra = {
                        url: URL.createObjectURL(extraBlob),
                        label: input.extra.label,
                        bytes: extraBlob.size,
                    };
                }
            }

            const record: PayloadRecord = {
                id: `pl_${at.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                at,
                phase: input.phase,
                imageId: input.imageId || '',
                imageName: input.imageName || '',
                regionIds: input.regionIds ?? [],
                transforms: input.transforms,
                model: input.phase === 'redraw'
                    ? (input.config.provider === 'openai' ? input.config.openaiModel : input.config.geminiModel)
                    : input.config.translationModel,
                prompt: input.prompt,
                compressionTargetKB: input.transforms.includes('compress')
                    ? (input.phase === 'redraw'
                        ? input.config.aiPayloadRedrawTargetKB
                        : input.config.aiPayloadTranslationTargetKB)
                    : undefined,
                bytes: blob.size,
                imageUrl: URL.createObjectURL(blob),
                extra,
            };

            // Newest first. Requests run concurrently and finish out of order,
            // so sort by the stamp taken when the payload was handed over.
            const next = [record, ...records].sort((a, b) => b.at - a.at);
            next.slice(MAX_RECORDS).forEach(releaseRecord);
            records = next.slice(0, MAX_RECORDS);
            emit();
        } catch { /* diagnostics must never surface as a failure */ }
    })();
};
