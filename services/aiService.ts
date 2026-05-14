
import { GoogleGenAI } from "@google/genai";
import { AppConfig } from "../types";
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
 * throw immediately so the outer round-based retry in useImageProcessor can
 * decide what to do next round — which frees the concurrency slot for the
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

      // Non-429: bail. Round-level retry (useImageProcessor) takes over.
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
  timeoutMs?: number
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
          ...(timeoutMs ? { config: { httpOptions: { timeout: timeoutMs } } } : {}),
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
  const { openaiBaseUrl, openaiApiKey, openaiModel, openaiStream } = config;

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
    const isStream = openaiStream === true;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${safeApiKey}`,
      },
      body: JSON.stringify({
        model: openaiModel,
        messages: messages,
        stream: isStream,
        max_tokens: 4096
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

    let content = '';

    if (isStream && response.body) {
        // Handle Streaming Response.
        // SSE chunks can split a single `data: {...}` line mid-JSON; the previous
        // line-at-a-time parse swallowed those as JSON errors and lost tokens.
        // Buffer raw bytes, only emit fully \n-terminated lines, flush the tail.
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = '';
        let done = false;

        const processLine = (line: string): string | undefined => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) return;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') return;
            try {
                const json = JSON.parse(dataStr);

                // Check for custom images in stream (support for non-standard proxies)
                if (json.choices?.[0]?.message?.images?.[0]?.image_url?.url) {
                    return json.choices[0].message.images[0].image_url.url;
                }

                const deltaContent = json.choices?.[0]?.delta?.content || '';
                content += deltaContent;
            } catch (e) {
                console.warn("Stream parsing error", e);
            }
        };

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;

            if (value) {
                buffer += decoder.decode(value, { stream: true });
            }

            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx);
                buffer = buffer.slice(newlineIdx + 1);
                const earlyImage = processLine(line);
                if (earlyImage) return earlyImage;
            }
        }

        // Flush decoder and any trailing partial line that lacked a final \n.
        const tail = buffer + decoder.decode();
        if (tail.length > 0) {
            const earlyImage = processLine(tail);
            if (earlyImage) return earlyImage;
        }
    } else {
        // Handle Normal Response
        const data = await response.json();

        // Support for custom 'images' array in message (e.g. Gemini-OpenAI-Proxy)
        const message = data.choices?.[0]?.message;
        if (message?.images && Array.isArray(message.images) && message.images.length > 0) {
             const firstImg = message.images[0];
             if (firstImg?.image_url?.url) {
                 return firstImg.image_url.url;
             }
        }

        content = message?.content || '';
    }

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

/**
 * Perform translation using an OpenAI-compatible endpoint.
 * Returns the translated text found in the image.
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
          max_tokens: 2048
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
    return await executeWithRetry(worker, timeout, signal);
  } catch (error) {
      console.error("Translation API Error", error);
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
  // All other failures bubble up; the round-level retry in useImageProcessor
  // picks them up in the next round.
  const timeout = config.apiTimeout || 60000;

  // The wrapper hands us a per-attempt signal that aborts on outer cancel
  // OR the timeout — forward it down to fetch / SDK so they actually stop.
  const worker = async (opSignal: AbortSignal) => {
    if (config.provider === 'openai') {
      if (!config.openaiApiKey) throw new Error("OpenAI API Key is missing");
      return generateOpenAIImage(imageBase64, prompt, config, opSignal);
    } else {
      return generateGeminiImage(imageBase64, prompt, config.geminiModel, config.geminiApiKey, opSignal, timeout);
    }
  };

  return executeWithRetry(worker, timeout, signal);
};
