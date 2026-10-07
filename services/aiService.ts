
import { GoogleGenAI } from "@google/genai";
import { AppConfig, translationReasoningParams } from "../types";
import { fetchImageAsBase64 } from "./imageUtils";
import { DEFAULT_TRANSLATION_PROMPT, TRANSLATION_CONTEXT_SYSTEM_PROMPT } from "../hooks/useConfig";
import { globalRateLimitGate, parseRetryAfter, isRateLimitError } from "./rateLimitGate";


/**
 * Helper to sanitize header values (API Keys) to prevent
 * "Failed to read the 'headers' property from 'RequestInit': String contains non ISO-8859-1 code point."
 * This removes non-ISO-8859-1 characters (like Chinese characters, emojis) which cause fetch to crash.
 */
const sanitizeHeaderValue = (value: string): string => {
  return value.replace(/[^\x00-\xFF]/g, '').trim();
};

/**
 * Fetch available models from OpenAI compatible API
 */
export const fetchOpenAIModels = async (
  baseUrl: string,
  apiKey: string
): Promise<string[]> => {
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  // Standard OpenAI models endpoint is /models
  // Some proxies use /v1/models
  const url = cleanBaseUrl.endsWith('/v1') 
    ? `${cleanBaseUrl}/models` 
    : `${cleanBaseUrl}/v1/models`;

  const safeApiKey = sanitizeHeaderValue(apiKey);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${safeApiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    const data = await response.json();
    if (Array.isArray(data.data)) {
      return data.data.map((m: any) => m.id).sort();
    }
    return [];
  } catch (error) {
    console.error("Error fetching models:", error);
    throw error;
  }
};

/**
 * Wrapper that enforces the per-request timeout and the GLOBAL 429 cool-down.
 *
 * Retry policy here is NARROW: we only retry inline on 429 / rate-limit
 * signals, because those need to back off coordinated with all other
 * in-flight calls (via globalRateLimitGate) to avoid IP bans.
 *
 * All other failures (timeouts, 5xx, network errors, content-policy refusals)
 * throw immediately so the outer per-region retry loop in useImageProcessor
 * can decide what to do next — which frees the concurrency slot for the
 * next region instead of busy-waiting on a single one.
 *
 * Implementation details:
 * - Per-attempt AbortController so timeouts actually cancel the underlying
 *   fetch / SDK call (not just the wrapper promise).
 * - 429 inline retries are capped at MAX_429_RETRIES — the gate handles the
 *   wait, so we don't sleep here, we just loop and let `await wait()` block.
 */
const MAX_429_RETRIES = 5;

async function executeWithRetry<T>(
  operation: (opSignal: AbortSignal) => Promise<T>,
  timeoutMs: number = 60000,
  signal?: AbortSignal
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Block on the global gate (no-op if not tripped). If a parallel call
    // tripped the gate while we were waiting on the semaphore, this is where
    // we honour it.
    await globalRateLimitGate.wait(signal);

    const controller = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await operation(controller.signal);
    } catch (error: any) {
      lastError = error;

      // Outer-cancel: never retry, propagate the abort.
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Normalise timeout errors so callers can distinguish "we cancelled"
      // from "the server returned an error".
      if (timedOut) {
        lastError = new Error(`Operation timed out after ${timeoutMs}ms`);
      }

      // 429: trip the global gate and retry inline (other in-flight calls
      // will also pause once they reach `await wait()`).
      if (isRateLimitError(error)) {
        const retryAfterMs = parseRetryAfter(error.retryAfter);
        const waitMs = globalRateLimitGate.trip(retryAfterMs);
        console.warn(
          `Rate-limited (429). Gate tripped for ${Math.round(waitMs)}ms. ` +
          `Inline attempt ${attempt + 1}/${MAX_429_RETRIES + 1}.`
        );
        if (attempt < MAX_429_RETRIES) {
          continue; // next iteration's `await wait()` will honour the gate
        }
        throw lastError;
      }

      // Non-429: bail. Per-region retry loop (useImageProcessor) takes over.
      throw lastError;
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  throw lastError;
}

/**
 * Handles communication with Gemini API (Native Google SDK)
 *
 * `signal` is honoured pre/post-call (the SDK does not expose AbortSignal
 * yet), and `timeoutMs` is forwarded as httpOptions.timeout so the SDK can
 * actually cancel the underlying HTTP request when our wrapper times out.
 */
const generateGeminiImage = async (
  imageBase64: string,
  prompt: string,
  modelName: string,
  apiKey: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  extraParams?: Record<string, unknown>
): Promise<string> => {
  // Allow custom API Key from settings, fallback to env var
  const finalApiKey = apiKey || process.env.API_KEY;

  if (!finalApiKey) {
      throw new Error("Gemini API Key is missing. Please set it in Settings.");
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const ai = new GoogleGenAI({ apiKey: finalApiKey });

  const cleanBase64 = imageBase64.includes(',')
    ? imageBase64.split(',')[1]
    : imageBase64;

  const apiCall = async () => {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: cleanBase64 } },
              { text: prompt },
            ],
          },
          // 附加参数并入 config（Gemini 侧的"请求选项"包）；没填就完全不出现
          // 这个键，请求与以前逐字节一致。
          ...((timeoutMs || extraParams)
            ? {
                config: {
                  ...(timeoutMs ? { httpOptions: { timeout: timeoutMs } } : {}),
                  ...(extraParams || {}),
                },
              }
            : {}),
        });

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        if (response.candidates && response.candidates.length > 0) {
          const candidate = response.candidates[0];
          if (candidate.content && candidate.content.parts) {
            // 1. Look for Image in the response
            for (const part of candidate.content.parts) {
              if (part.inlineData && part.inlineData.data) {
                 const mimeType = part.inlineData.mimeType || 'image/png';
                 return `data:${mimeType};base64,${part.inlineData.data}`;
              }
            }

            // 2. Look for Text (often contains error messages or refusals)
            const textParts = candidate.content.parts
              .filter(p => p.text)
              .map(p => p.text)
              .join(' ');

            if (textParts) {
               throw new Error(`Gemini response: ${textParts}`);
            }
          }
        }

        throw new Error("Gemini returned an empty response (no candidates or parts).");

      } catch (error: any) {
        // If it's already our custom error, rethrow
        if (error.message && error.message.startsWith('Gemini')) {
            throw error;
        }
        console.error("Gemini API Error:", error);
        // Preserve status / code / retryAfter so the upstream retry logic
        // can detect 429-equivalent (RESOURCE_EXHAUSTED) signals from the SDK.
        const e: any = new Error(`Gemini API Failed: ${error.message || 'Unknown error'}`);
        if (error.status != null) e.status = error.status;
        if (error.code != null) e.code = error.code;
        if (error.retryAfter != null) e.retryAfter = error.retryAfter;
        throw e;
      }
  };

  return apiCall();
};

/**
 * 用户在「连接设置 → 附加请求参数」里写的 JSON 对象（AppConfig.imageApiExtraParams）。
 *
 * 解析得很宽松：空串 / 语法错 / 不是对象 → 返回 undefined（= 不附加任何字段），
 * 因为这是"大多数时候用不上"的逃生口，写坏一次不该把整次重绘打成失败。
 */
const parseExtraParams = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    console.warn('[imageApiExtraParams] 附加请求参数不是合法 JSON 对象，本次忽略：', raw);
    return undefined;
  }
};

/**
 * Helper to process the final content string (whether from full response or accumulated stream)
 */
const processContentToImage = async (content: string): Promise<string> => {
    // 1. Try Markdown Image Regex
    const markdownRegex = /!\[.*?\]\((.*?)\)/;
    const mdMatch = content.match(markdownRegex);
    if (mdMatch && mdMatch[1]) {
      return await fetchImageAsBase64(mdMatch[1]);
    }

    // 2. Try Raw URL Regex (simple http/s extraction)
    const urlRegex = /(https?:\/\/[^\s)]+)/;
    const urlMatch = content.match(urlRegex);
    if (urlMatch && urlMatch[1]) {
      // Remove potential trailing punctuation often returned by LLMs (e.g. "https://site.com/img.png.")
      let cleanUrl = urlMatch[1].replace(/[.,;>]+$/, "");
      return await fetchImageAsBase64(cleanUrl);
    }

    // 3. Last resort: check if content IS the base64 string
    if (content.startsWith('data:image') || (content.length > 1000 && !content.includes(' '))) {
         return content.startsWith('data:') ? content : `data:image/png;base64,${content}`;
    }

    console.warn("Could not find image URL in response:", content);
    throw new Error("The model responded with text but no detectable image URL. Response: " + content.substring(0, 100) + "...");
}

/**
 * Handles communication with OpenAI Compatible API via Chat Completions
 * This supports Multimodal inputs (Text + Image) for models like Gemini Pro Vision / GPT-4o
 */
const generateOpenAIImage = async (
  imageBase64: string,
  prompt: string,
  config: AppConfig,
  signal?: AbortSignal
): Promise<string> => {
  const { openaiBaseUrl, openaiApiKey, openaiModel } = config;

  const safeApiKey = sanitizeHeaderValue(openaiApiKey);

  // Ensure we hit the chat completions endpoint as per user request
  // Handle case where user might or might not have included /v1 in the base URL
  let cleanBaseUrl = openaiBaseUrl.replace(/\/$/, "");
  if (!cleanBaseUrl.endsWith('/v1')) {
     cleanBaseUrl += '/v1';
  }
  const url = `${cleanBaseUrl}/chat/completions`;

  // Construct the Multimodal Message
  // This matches the structure: messages: [{ role: "user", content: [{type: "text", ...}, {type: "image_url", ...}] }]
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt
        },
        {
          type: "image_url",
          image_url: {
            // Ensure data URI format
            url: imageBase64.startsWith('data:')
              ? imageBase64
              : `data:image/png;base64,${imageBase64}`
          }
        }
      ]
    }
  ];

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${safeApiKey}`,
      },
      body: JSON.stringify({
        model: openaiModel,
        messages: messages,
        max_tokens: 4096,
        // 附加参数放在最后：用户显式写下的键覆盖内置字段。
        ...(parseExtraParams(config.imageApiExtraParams) || {}),
      }),
      signal: signal
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const e: any = new Error(`OpenAI API Error: ${err.error?.message || response.statusText}`);
      e.status = response.status;
      e.retryAfter = response.headers.get('Retry-After');
      throw e;
    }

    const data = await response.json();

    // Support for custom 'images' array in message (e.g. Gemini-OpenAI-Proxy)
    const message = data.choices?.[0]?.message;
    if (message?.images && Array.isArray(message.images) && message.images.length > 0) {
         const firstImg = message.images[0];
         if (firstImg?.image_url?.url) {
             return firstImg.image_url.url;
         }
    }

    const content = message?.content || '';

    if (!content) {
      throw new Error("OpenAI returned no content.");
    }

    return await processContentToImage(content);

  } catch (error) {
    if ((error as Error).name === 'AbortError') {
        throw error; // Re-throw aborts to be caught by the UI
    }
    console.error("OpenAI Chat Generation Error:", error);
    throw error;
  }
};

/** data URI（或裸 base64）→ Blob，保留原始 mime —— 压缩后的 payload 可能是
 *  WebP，转成 PNG 会白白放大体积。 */
const base64ToBlob = async (imageBase64: string): Promise<{ blob: Blob; mime: string }> => {
  if (imageBase64.startsWith('data:')) {
    const blob = await (await fetch(imageBase64)).blob();
    return { blob, mime: blob.type || 'image/png' };
  }
  const binary = atob(imageBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: 'image/png' }), mime: 'image/png' };
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Handles the OpenAI-compatible dedicated image endpoint:
 * `POST {baseUrl}/v1/images/edits` — multipart/form-data image-to-image.
 *
 * Differences from generateOpenAIImage (chat/completions):
 * - the crop travels as the standard `image` file field instead of being
 *   embedded in `messages`;
 * - never streams — the endpoint has no SSE mode;
 * - `response_format` / `size` are deliberately NOT sent: gpt-image-1 rejects
 *   unknown parameters with a 400, so whatever comes back wins — `b64_json`
 *   is used directly, `url` is fetched and converted to base64.
 */
const generateOpenAIImageEdit = async (
  imageBase64: string,
  prompt: string,
  config: AppConfig,
  signal?: AbortSignal
): Promise<string> => {
  const { openaiBaseUrl, openaiApiKey, openaiModel } = config;

  const safeApiKey = sanitizeHeaderValue(openaiApiKey);

  let cleanBaseUrl = openaiBaseUrl.replace(/\/$/, "");
  if (!cleanBaseUrl.endsWith('/v1')) {
    cleanBaseUrl += '/v1';
  }
  const url = `${cleanBaseUrl}/images/edits`;

  const { blob, mime } = await base64ToBlob(imageBase64);
  const ext = EXT_BY_MIME[mime] || 'png';

  const form = new FormData();
  form.append('model', openaiModel);
  form.append('prompt', prompt);
  form.append('n', '1');
  // 文件名后缀跟着 mime 走 —— 个别中转站靠后缀猜类型。
  form.append('image', blob, `image.${ext}`);

  // 附加参数：multipart 只有字符串，对象/数组就地序列化成 JSON 文本。
  const extraParams = parseExtraParams(config.imageApiExtraParams);
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // 不要手写 Content-Type：multipart 的 boundary 必须由浏览器生成。
        'Authorization': `Bearer ${safeApiKey}`,
      },
      body: form,
      signal: signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const e: any = new Error(`Image Edits API Error: ${err.error?.message || response.statusText}`);
      e.status = response.status;
      e.retryAfter = response.headers.get('Retry-After');
      if (response.status === 404 || response.status === 405) {
        e.message += "（该地址似乎没有 /images/edits 接口，可在「连接设置 → 图片接口」切回 Chat Completions）";
      }
      throw e;
    }

    const data = await response.json();
    const first = data?.data?.[0];
    if (!first) {
      throw new Error("Image Edits API returned no image data.");
    }

    if (first.b64_json) {
      return `data:image/png;base64,${first.b64_json}`;
    }

    const returnedUrl = first.url || first.image_url?.url;
    if (returnedUrl) {
      return await fetchImageAsBase64(returnedUrl);
    }

    throw new Error("Image Edits API response had neither b64_json nor url.");
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
        throw error; // Re-throw aborts to be caught by the UI
    }
    console.error("OpenAI Image Edits Error:", error);
    throw error;
  }
};

/**
 * Perform translation using an OpenAI-compatible endpoint. Returns the
 * translation text (trimmed).
 */
export const generateTranslation = async (
  imageBase64: string,
  config: AppConfig,
  signal?: AbortSignal,
  contextImageBase64?: string
): Promise<string> => {
  const { translationBaseUrl, translationApiKey, translationModel, translationPrompt } = config;

  if (!translationApiKey || !translationBaseUrl) {
      throw new Error("Translation API Key or Base URL missing.");
  }

  const safeApiKey = sanitizeHeaderValue(translationApiKey);
  let cleanBaseUrl = translationBaseUrl.replace(/\/$/, "");
  if (!cleanBaseUrl.endsWith('/v1')) {
     cleanBaseUrl += '/v1';
  }
  const url = `${cleanBaseUrl}/chat/completions`;

  const useContext = !!contextImageBase64;
  const prompt = useContext
    ? TRANSLATION_CONTEXT_SYSTEM_PROMPT
    : (translationPrompt || DEFAULT_TRANSLATION_PROMPT);

  const imageContent: any[] = [
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: {
        url: imageBase64.startsWith('data:')
          ? imageBase64
          : `data:image/png;base64,${imageBase64}`
      }
    }
  ];

  if (useContext) {
    imageContent.push({
      type: "image_url",
      image_url: {
        url: contextImageBase64!.startsWith('data:')
          ? contextImageBase64!
          : `data:image/png;base64,${contextImageBase64}`
      }
    });
  }

  const messages = [
    {
      role: "user",
      content: imageContent
    }
  ];

  try {
    const worker = async (opSignal: AbortSignal): Promise<string> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${safeApiKey}`,
        },
        body: JSON.stringify({
          model: translationModel,
          messages: messages,
          max_tokens: 2048,
          // 思考强度（reasoning_effort）：'none' = 不思考。
          ...translationReasoningParams(config.translationReasoningEffort),
        }),
        signal: opSignal
      });

      if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const e: any = new Error(`Translation API Error: ${err.error?.message || response.statusText}`);
          e.status = response.status;
          e.retryAfter = response.headers.get('Retry-After');
          throw e;
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    };

    const timeout = config.apiTimeout || 60000;
    const content = await executeWithRetry(worker, timeout, signal);
    return content.trim();
  } catch (error) {
      console.error("Translation API Error", error);
      throw error;
  }
};

/**
 * Pure-text chat completion against the translation endpoint (no image
 * payload). Used by the glossary AI pick: variant choice is language
 * knowledge, not visual knowledge, so no page images are sent.
 */
export const generateTextCompletion = async (
  prompt: string,
  config: AppConfig,
  signal?: AbortSignal,
  maxTokens: number = 4096
): Promise<string> => {
  const { translationBaseUrl, translationApiKey, translationModel } = config;

  if (!translationApiKey || !translationBaseUrl) {
      throw new Error("Translation API Key or Base URL missing.");
  }

  const safeApiKey = sanitizeHeaderValue(translationApiKey);
  let cleanBaseUrl = translationBaseUrl.replace(/\/$/, "");
  if (!cleanBaseUrl.endsWith('/v1')) {
     cleanBaseUrl += '/v1';
  }
  const url = `${cleanBaseUrl}/chat/completions`;

  try {
    const worker = async (opSignal: AbortSignal): Promise<string> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${safeApiKey}`,
        },
        body: JSON.stringify({
          model: translationModel,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          // 思考强度（reasoning_effort）：'none' = 不思考。
          ...translationReasoningParams(config.translationReasoningEffort),
        }),
        signal: opSignal
      });

      if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const e: any = new Error(`Translation API Error: ${err.error?.message || response.statusText}`);
          e.status = response.status;
          e.retryAfter = response.headers.get('Retry-After');
          throw e;
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    };

    const timeout = config.apiTimeout || 60000;
    const content = await executeWithRetry(worker, timeout, signal);
    return content.trim();
  } catch (error) {
      console.error("Text Completion API Error", error);
      throw error;
  }
};

/**
 * Main Router Function
 */
export const generateRegionEdit = async (
  imageBase64: string,
  prompt: string,
  config: AppConfig,
  signal?: AbortSignal
): Promise<string> => {

  // Default to 60s timeout if not configured (backwards compat).
  // Retry on 429 is inline (handled by executeWithRetry + globalRateLimitGate).
  // All other failures bubble up; the per-region retry loop in useImageProcessor
  // picks them up on the next pass.
  const timeout = config.apiTimeout || 60000;

  // The wrapper hands us a per-attempt signal that aborts on outer cancel
  // OR the timeout — forward it down to fetch / SDK so they actually stop.
  const worker = async (opSignal: AbortSignal) => {
    if (config.provider === 'openai') {
      if (!config.openaiApiKey) throw new Error("OpenAI API Key is missing");
      // 图片接口形态由「连接设置 → 图片接口」决定：
      // 'chat' = 多模态对话生图（历史默认）；'edit' = 图像专用 /v1/images/edits。
      return config.openaiImageEndpointMode === 'edit'
        ? generateOpenAIImageEdit(imageBase64, prompt, config, opSignal)
        : generateOpenAIImage(imageBase64, prompt, config, opSignal);
    } else {
      return generateGeminiImage(
        imageBase64,
        prompt,
        config.geminiModel,
        config.geminiApiKey,
        opSignal,
        timeout,
        parseExtraParams(config.imageApiExtraParams)
      );
    }
  };

  return executeWithRetry(worker, timeout, signal);
};
