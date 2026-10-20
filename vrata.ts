import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export interface VrataConfig { apiKey: string; baseUrl: string }
export interface VrataModel {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  contextWindow: number;
  maxTokens: number;
  images: boolean;
  tools: boolean;
  reasoning: boolean;
  transport: "chat_completions" | "responses" | "messages";
}

export type VrataReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

const builtinModels: Model<Api>[] =
  (["openai", "anthropic", "google", "xai", "deepseek", "mistral", "zai"] as const)
    .flatMap((provider) => getBuiltinModels(provider));

export function apiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("Адрес API должен содержать только origin или /v1");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Для API Врата AI требуется HTTPS");
  }
  return `${url.origin}/v1`;
}

export function parseModels(input: unknown, protocol: VrataModel["protocol"] = "openai"): VrataModel[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as { data?: unknown }).data)) throw new Error("Некорректный ответ каталога моделей");
  const result: VrataModel[] = [];
  for (const row of (input as { data: unknown[] }).data) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as { id?: unknown; gateway_metadata?: Record<string, unknown> };
    if (typeof candidate.id !== "string" || !candidate.id || candidate.id.length > 200) continue;
    const meta = candidate.gateway_metadata ?? {};
    const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
    result.push({
      id: candidate.id,
      name: typeof meta.name === "string" ? meta.name : candidate.id,
      protocol,
      contextWindow: positive(meta.max_input_tokens, 32_000),
      maxTokens: positive(meta.max_output_tokens, 4_096),
      images: meta.supports_images === true,
      tools: meta.supports_tools === true,
      reasoning: typeof meta.supports_reasoning === "boolean" ? meta.supports_reasoning : builtinModels.some((model) => model.id === candidate.id && model.reasoning),
      transport: meta.verified_transport === "chat_completions" ? "chat_completions"
        : meta.verified_transport === "messages" ? "messages"
        : meta.verified_transport === "responses" ? "responses"
        : protocol === "anthropic" ? "messages" : "responses",
    });
  }
  return result;
}

export async function fetchModels(config: VrataConfig, signal?: AbortSignal): Promise<VrataModel[]> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  async function load(protocol: VrataModel["protocol"]): Promise<VrataModel[]> {
    const response = await fetch(`${apiBaseUrl(config.baseUrl)}/models`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(protocol === "anthropic" ? { "Anthropic-Version": "2023-06-01" } : {}),
      },
      signal: requestSignal,
    });
    if (response.status === 401 || response.status === 403) throw new Error("Ключ Врата AI недействителен или не имеет доступа к моделям");
    if (!response.ok) throw new Error(`Каталог Врата AI вернул HTTP ${response.status}`);
    return parseModels(await response.json(), protocol);
  }
  const [openai, anthropic] = await Promise.allSettled([load("openai"), load("anthropic")]);
  signal?.throwIfAborted();
  if (openai.status === "rejected" && anthropic.status === "rejected") throw openai.reason;
  const models = new Map<string, VrataModel>();
  for (const model of openai.status === "fulfilled" ? openai.value : []) models.set(model.id, model);
  for (const model of anthropic.status === "fulfilled" ? anthropic.value : []) {
    if (!models.has(model.id)) models.set(model.id, model);
  }
  return [...models.values()];
}

export function piModel(model: VrataModel, config: VrataConfig): Model<Api> {
  const api = model.transport === "messages" ? "anthropic-messages"
    : model.transport === "chat_completions" ? "openai-completions" : "openai-responses";
  const builtin = builtinModels.find((candidate) => candidate.id === model.id && candidate.api === api);
  return {
    id: model.id,
    name: model.name,
    api,
    provider: "vrata",
    baseUrl: api === "anthropic-messages" ? new URL(apiBaseUrl(config.baseUrl)).origin : apiBaseUrl(config.baseUrl),
    reasoning: model.reasoning,
    thinkingLevelMap: builtin?.thinkingLevelMap,
    compat: builtin?.compat,
    input: model.images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function supportedReasoningLevels(model: Model<Api>): VrataReasoningLevel[] {
  return getSupportedThinkingLevels(model)
    .filter((level) => level !== "minimal")
    .map((level) => level === "off" ? "none" : level);
}
