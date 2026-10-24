import { z } from "zod";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

export const VRATA_PROVIDER_ID = "vrata.tg";

export interface VrataConfig { apiKey: string; baseUrl: string }
export type VrataReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type VrataCatalogProtocol = "openai" | "anthropic";
const tokenLimit = z.number().int().positive().nullish().catch(undefined);
const pricePerMillion = z.string().regex(/^\d+(?:\.\d+)?$/)
  .transform((value) => Number(value) * 1_000_000).pipe(z.number().nonnegative()).optional().catch(undefined);
const catalogRowSchema = z.object({
  id: z.string().min(1).max(200),
  gateway_metadata: z.object({
    name: z.string().min(1).max(200).nullish().catch(undefined),
    protocol: z.enum(["openai", "anthropic"]).nullish().catch(undefined),
    verified_transport: z.enum(["chat_completions", "responses", "messages"]).nullish().catch(undefined),
    max_input_tokens: tokenLimit,
    max_output_tokens: tokenLimit,
    supports_tools: z.boolean().nullish().catch(undefined),
    supports_images: z.boolean().nullish().catch(undefined),
  }).nullish().catch(undefined),
  gateway_pricing: z.object({
    currency: z.literal("RUB"), unit: z.literal("token"),
    prompt: pricePerMillion, completion: pricePerMillion,
    input_cache_read: pricePerMillion, input_cache_write: pricePerMillion,
  }).nullish().catch(undefined),
});
export type VrataCatalogModel = z.infer<typeof catalogRowSchema> & { protocol: VrataCatalogProtocol };
const anthropicModels = new Map(getBuiltinModels("anthropic").map((entry) => [entry.id, entry]));
const openaiModels = new Map(getBuiltinModels("openai").map((entry) => [entry.id, entry]));

/** Availability and gateway metadata come from the API; Pi owns native reasoning semantics. */
export function buildPiModels(catalog: VrataCatalogModel[], baseUrl: string): Model<Api>[] {
  const base = apiBaseUrl(baseUrl);
  return catalog.filter((entry) => entry.gateway_metadata?.supports_tools !== false).map(({ id, protocol, gateway_metadata: metadata, gateway_pricing: pricing }) => {
    const transport = !metadata?.protocol || metadata.protocol === protocol ? metadata?.verified_transport : undefined;
    const api = protocol === "anthropic" ? "anthropic-messages"
      : transport === "chat_completions" ? "openai-completions"
      : transport === "responses" ? "openai-responses"
      : /^gemini(?:-|$)/i.test(id) ? "openai-completions" : "openai-responses";
    const anthropic = api === "anthropic-messages" ? anthropicModels.get(id) : undefined;
    // Pi's Chat adapter sends an off effort only when it has an explicit mapping.
    const thinkingLevelMap = anthropic?.thinkingLevelMap ?? openaiModels.get(id)?.thinkingLevelMap
      ?? (api === "openai-completions" ? { off: "none" } : undefined);
    const input = pricing?.prompt ?? 0;
    return {
      ...anthropic,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      id, name: metadata?.name ?? id, provider: VRATA_PROVIDER_ID, api,
      baseUrl: api === "anthropic-messages" ? new URL(base).origin : base,
      reasoning: true, input: metadata?.supports_images === false ? ["text"] : ["text", "image"],
      cost: { input, output: pricing?.completion ?? 0,
        cacheRead: pricing?.input_cache_read ?? input, cacheWrite: pricing?.input_cache_write ?? input },
      contextWindow: metadata?.max_input_tokens ?? 128_000,
      maxTokens: metadata?.max_output_tokens ?? 16_384,
    };
  });
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

export async function fetchModels(config: VrataConfig, signal?: AbortSignal): Promise<VrataCatalogModel[]> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  async function load(protocol: VrataCatalogProtocol): Promise<VrataCatalogModel[]> {
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
    return (body as { data: unknown[] }).data.flatMap((row) => {
      const parsed = catalogRowSchema.safeParse(row);
      return parsed.success ? [{ ...parsed.data, protocol }] : [];
    });
  }
  const [openai, anthropic] = await Promise.allSettled([load("openai"), load("anthropic")]);
  signal?.throwIfAborted();
  if (openai.status === "rejected" && anthropic.status === "rejected") {
    const message = openai.reason instanceof Error ? openai.reason.message : "Не удалось получить каталог Врата AI";
    throw new Error(message.split(config.apiKey).join("[redacted]"));
  }
  const models = new Map<string, VrataCatalogModel>();
  for (const model of openai.status === "fulfilled" ? openai.value : []) models.set(model.id, model);
  for (const model of anthropic.status === "fulfilled" ? anthropic.value : []) models.set(model.id, model);
  return [...models.values()];
}

export function supportedReasoningLevels(model: Model<Api>): VrataReasoningLevel[] {
  return getSupportedThinkingLevels(model)
    .filter((level) => level !== "minimal")
    .map((level) => level === "off" ? "none" : level);
}

/** Convert server-discovered models to the BB bridge selection contract. */
export function buildPiAvailableModels(piModels: Model<Api>[]): { models: AvailableModel[]; selectedOnlyModels: AvailableModel[] } {
  const models = piModels.map((model, index): AvailableModel => {
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
