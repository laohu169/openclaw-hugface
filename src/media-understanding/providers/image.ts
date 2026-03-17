import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../../agents/minimax-vlm.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { normalizeModelRef } from "../../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { coerceImageAssistantText } from "../../agents/tools/image-tool.helpers.js";
import type { ImageDescriptionRequest, ImageDescriptionResult } from "../types.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../../agents/pi-model-discovery-runtime.js")
> | null = null;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  // 🚀 物理修复：直接使用环境变量，彻底无视 Root 环境下的路径加载问题
  const apiKey = process.env.OPENAI_API_KEY || "";
  const modelId = process.env.OPENCLAW_DEFAULT_MODEL || "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_BASE_URL;

  const mockModel: any = {
    id: modelId,
    provider: "openai",
    baseUrl: baseUrl
  };

  const base64 = params.buffer.toString("base64");
  
  // 保持 Minimax 逻辑兼容
  if (isMinimaxVlmModel(mockModel.provider, mockModel.id)) {
    const text = await minimaxUnderstandImage({
      apiKey,
      prompt: params.prompt ?? "Describe the image.",
      imageDataUrl: `data:${params.mime ?? "image/jpeg"};base64,${base64}`,
      modelBaseUrl: baseUrl,
    });
    return { text, model: mockModel.id };
  }

  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt ?? "Describe the image." },
          { type: "image", data: base64, mimeType: params.mime ?? "image/jpeg" },
        ],
        timestamp: Date.now(),
      },
    ],
  };

  // 🚀 强制直连 complete，并补全中转站所需的 headers (解决 401 错误)
  const message = await complete(mockModel, context, {
    apiKey,
    maxTokens: params.maxTokens ?? 1024,
    baseUrl: baseUrl,
    headers: {
      "HTTP-Referer": "https://huggingface.co/",
      "X-Title": "OpenClaw"
    }
  } as any);

  const text = coerceImageAssistantText({
    message,
    provider: mockModel.provider,
    model: mockModel.id,
  });
  return { text, model: mockModel.id };
}
