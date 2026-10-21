import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

export const VRATA_PROVIDER_ID = "vrata.tg";

export interface VrataConfig { apiKey: string; baseUrl: string }
export type VrataReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** The user's Pi guide is the source of truth for the native provider catalog. */
export function guideModels(baseUrl: string): Model<Api>[] {
  const base = apiBaseUrl(baseUrl);
  const anthropic = getBuiltinModels("anthropic");
  const apis = { a: "anthropic-messages", r: "openai-responses", c: "openai-completions" } as const;
  const model = (id: string, kind: keyof typeof apis,
    prices: [number, number, number?, number?], contextWindow = 1_000_000, maxTokens = 128_000): Model<Api> => {
    const [input, output, cacheRead = input, cacheWrite = input] = prices;
    return {
      ...(kind === "a" ? anthropic.find((entry) => entry.id === id) : undefined),
      id, name: id, provider: VRATA_PROVIDER_ID, api: apis[kind],
      baseUrl: kind === "a" ? new URL(base).origin : base,
      reasoning: true, input: ["text", "image"],
      cost: { input, output, cacheRead, cacheWrite }, contextWindow, maxTokens,
    };
  };
  return [
    model("claude-fable-5-1", "a", [60, 300, 1.5, 74]),
    model("claude-haiku-5-5", "a", [5.5, 26.5, 0.55, 6.6]),
    model("claude-opus-4-8", "a", [25, 128, 2.6, 32]),
    model("claude-opus-5-5", "a", [24, 120, 1.2, 30]),
    model("claude-sonnet-5-5", "a", [10, 51, 1, 13]),
    model("deepseek-v4.1-flash", "r", [12, 48, 0.5], 1_000_000, 384_000),
    model("gemini-3.8-flash", "c", [6, 26, 0.6], 1_000_000, 64_000),
    model("gemini-4-argon", "c", [13, 65, 1], 1_048_576, 65_536),
    model("glm-5.3", "r", [70, 240, 17]),
    model("glm-5.3-flash", "r", [3.5, 12, 1]),
    model("gpt-6-astra", "r", [40, 200, 4, 50], 1_050_000),
    model("gpt-6-luna", "r", [0.6, 3, 0.06, 0.7], 1_050_000),
    model("gpt-6.1-sol", "r", [12, 60, 1.2, 15], 1_050_000),
    model("grok-4.7", "r", [8, 24, 2], 1_000_000, 1_000_000),
  ];
}

/** Read one atomic credentials-file version; never interpret the key as Pi config syntax. */
export function readConfig(dataDir: string): VrataConfig | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, "credentials.json"), "utf8"));
    if (!value || typeof value !== "object") return undefined;
    const config = value as Partial<VrataConfig>;
    if (typeof config.apiKey !== "string" || !config.apiKey || typeof config.baseUrl !== "string") return undefined;
    return { apiKey: config.apiKey, baseUrl: apiBaseUrl(config.baseUrl) };
  } catch {
    // Filesystem/JSON/URL exceptions can contain credentials or file contents.
    return undefined;
  }
}

export function apiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Некорректный адрес API Врата AI"); }
  if (url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("Адрес API должен содержать только origin или /v1");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Для API Врата AI требуется HTTPS");
  }
  return `${url.origin}/v1`;
}

export async function fetchModels(config: VrataConfig, signal?: AbortSignal): Promise<{ id: string }[]> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  async function load(protocol: "openai" | "anthropic"): Promise<{ id: string }[]> {
    const response = await fetch(`${apiBaseUrl(config.baseUrl)}/models`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(protocol === "anthropic" ? { "Anthropic-Version": "2023-06-01" } : {}),
      },
      signal: requestSignal,
    });
    if (response.status === 401 || response.status === 403) throw new Error("Ключ Врата AI недействителен или не имеет доступа к моделям");
    if (!response.ok) throw new Error(`Каталог Врата AI вернул HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error("Некорректный ответ каталога моделей"); }
    requestSignal.throwIfAborted();
    if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
      throw new Error("Некорректный ответ каталога моделей");
    }
    return (body as { data: { id?: unknown }[] }).data
      .filter((row): row is { id: string } => !!row && typeof row.id === "string" && !!row.id && row.id.length <= 200)
      .map(({ id }) => ({ id }));
  }
  const [openai, anthropic] = await Promise.allSettled([load("openai"), load("anthropic")]);
  signal?.throwIfAborted();
  if (openai.status === "rejected" && anthropic.status === "rejected") {
    const message = openai.reason instanceof Error ? openai.reason.message : "Не удалось получить каталог Врата AI";
    throw new Error(message.split(config.apiKey).join("[redacted]"));
  }
  const models = new Map<string, { id: string }>();
  for (const model of openai.status === "fulfilled" ? openai.value : []) models.set(model.id, model);
  for (const model of anthropic.status === "fulfilled" ? anthropic.value : []) {
    if (!models.has(model.id)) models.set(model.id, model);
  }
  return [...models.values()];
}

export function supportedReasoningLevels(model: Model<Api>): VrataReasoningLevel[] {
  return getSupportedThinkingLevels(model)
    .filter((level) => level !== "minimal")
    .map((level) => level === "off" ? "none" : level);
}

/** BB selection metadata comes from the same guide as the native Pi extension. */
export function buildPiAvailableModels(): { models: AvailableModel[]; selectedOnlyModels: AvailableModel[] } {
  const models = guideModels("https://api.vrata.tg").map((model, index): AvailableModel => {
    const levels = supportedReasoningLevels(model);
    return {
      id: model.id, model: model.id, displayName: model.name, routeProviderId: "vrata",
      description: "Vrata.tg reasoning, multimodal model via Pi",
      supportedReasoningEfforts: levels.map((level) => ({
        reasoningEffort: level, description: level === "none" ? "No extended thinking" : `${level} reasoning`,
      })),
      defaultReasoningEffort: levels.includes("medium") ? "medium"
        : levels.find((level) => level !== "none") ?? "none",
      isDefault: index === 0,
    };
  });
  return { models, selectedOnlyModels: [] };
}
