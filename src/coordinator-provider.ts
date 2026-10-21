import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Config } from "./config.js";

/** Administrator-owned model metadata; wire conversion and authentication stay in pi-ai. */
export function createCoordinatorProvider(config: NonNullable<Config["coordinator"]>): Provider {
  switch (config.provider) {
    case "openai": return openaiProvider();
    case "anthropic": return anthropicProvider();
    case "deepseek": return deepseekProvider();
    case "openai-compatible": return createProvider({
      id: config.provider,
      baseUrl: config.baseUrl,
      auth: { apiKey: envApiKeyAuth("Coordinator API key", [config.apiKeyEnv]) },
      api: config.api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
      models: [{
        id: config.model, name: config.model, provider: config.provider,
        api: config.api, baseUrl: config.baseUrl, input: ["text"], reasoning: config.reasoning,
        contextWindow: config.contextWindow, maxTokens: config.maxTokens,
        // Unknown pricing, not a claim that the endpoint is free.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
  }
}
