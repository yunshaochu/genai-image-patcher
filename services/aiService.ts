

import { GoogleGenAI } from "@google/genai";
import { AppConfig } from "../types";
import { fetchImageAsBase64 } from "./imageUtils";

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
 * Wrapper function to handle retries and timeouts
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  timeoutMs: number = 60000,
  maxRetries: number = 0,
  signal?: AbortSignal
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      // Race the operation against a timeout
      // Note: We cannot easily cancel the underlying operation (like a fetch) just with a promise race,
      // but we can reject the wrapper promise to let the UI proceed/fail.
      const timeoutPromise = new Promise<never>((_, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id);
          reject(new Error(`Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        
        // If signal aborts while waiting for timeout
        signal?.addEventListener('abort', () => {
             clearTimeout(id);
             reject(new DOMException('Aborted', 'AbortError'));
        });
      });

      return await Promise.race([
        operation(),
        timeoutPromise
      ]);
    } catch (error: any) {
       lastError = error;
       
       // Don't retry if aborted
       if (signal?.aborted || error.name === 'AbortError') {
           throw error;
       }

       const isTimeout = error.message && error.message.includes('timed out');
       console.warn(`Attempt ${attempt + 1} failed (Timeout: ${isTimeout}):`, error);

       if (attempt < maxRetries) {
         // Wait a bit before retrying (1s)
         await new Promise(r => setTimeout(r, 1000));
       }
    }
  }

  throw lastError;
}

/**
 * Handles communication with Gemini API (Native Google SDK)
 */
const generateGeminiImage = async (
  imageBase64: string,
  prompt: string,
  modelName: string,
  signal?: AbortSignal
): Promise<string> => {
  // Use process.env.API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
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
        });

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
        throw new Error(`Gemini API Failed: ${error.message || 'Unknown error'}`);
      }
  };
  
  return apiCall();
};

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
        stream: false, // Force non-streaming to get the full response at once for easier parsing
        max_tokens: 4096 // Ensure we get a response
      }),
      signal: signal // Pass AbortSignal to fetch
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API Error: ${err.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("OpenAI returned no content.");
    }

    // Attempt to extract Image URL from the content
    // Models often return: "Here is the image: ![Alt](https://...)" or just "https://..."
    
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
    
    // 3. Last resort: check if content IS the base64 string (rare but possible for some proxies)
    if (content.startsWith('data:image') || (content.length > 1000 && !content.includes(' '))) {
         return content.startsWith('data:') ? content : `data:image/png;base64,${content}`;
    }

    console.warn("Could not find image URL in response:", content);
    throw new Error("The model responded with text but no detectable image URL. Response: " + content.substring(0, 100) + "...");

  } catch (error) {
    if ((error as Error).name === 'AbortError') {
        throw error; // Re-throw aborts to be caught by the UI
    }
    console.error("OpenAI Chat Generation Error:", error);
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
  
  const worker = async () => {
    if (config.provider === 'openai') {
      if (!config.openaiApiKey) throw new Error("OpenAI API Key is missing");
      return generateOpenAIImage(imageBase64, prompt, config, signal);
    } else {
      // Guidelines strictly state API Key must be from process.env.API_KEY
      return generateGeminiImage(imageBase64, prompt, config.geminiModel, signal);
    }
  };

  // Wrap the worker in the retry/timeout logic
  // Default to 60s timeout and 0 retries if not configured (backwards compat)
  const timeout = config.apiTimeout || 60000;
  const retries = config.maxRetries ?? 0;

  return executeWithRetry(worker, timeout, retries, signal);
};
