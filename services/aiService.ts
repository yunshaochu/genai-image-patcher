import { GoogleGenAI } from "@google/genai";
import { AppConfig } from "../types";
import { fetchImageAsBase64 } from "./imageUtils";

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

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
 * Handles communication with Gemini API (Native Google SDK)
 */
const generateGeminiImage = async (
  imageBase64: string,
  prompt: string,
  modelName: string
): Promise<string> => {
  // Use process.env.API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const cleanBase64 = imageBase64.includes(',') 
    ? imageBase64.split(',')[1] 
    : imageBase64;

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

/**
 * Handles communication with OpenAI Compatible API via Chat Completions
 * This supports Multimodal inputs (Text + Image) for models like Gemini Pro Vision / GPT-4o
 */
const generateOpenAIImage = async (
  imageBase64: string,
  prompt: string,
  config: AppConfig
): Promise<string> => {
  const { openaiBaseUrl, openaiApiKey, openaiModel } = config;
  
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
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: openaiModel,
        messages: messages,
        stream: false, // Force non-streaming to get the full response at once for easier parsing
        max_tokens: 4096 // Ensure we get a response
      })
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
  config: AppConfig
): Promise<string> => {
  if (config.provider === 'openai') {
    if (!config.openaiApiKey) throw new Error("OpenAI API Key is missing");
    // Now passing imageBase64 to OpenAI handler as well
    return generateOpenAIImage(imageBase64, prompt, config);
  } else {
    // Guidelines strictly state API Key must be from process.env.API_KEY
    // We assume process.env.API_KEY is available and valid.
    return generateGeminiImage(imageBase64, prompt, config.geminiModel);
  }
};