import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";

const NONE_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "none",
  description: "No extended thinking",
};

export interface PiCatalogModel {
  id: string;
  input: string[];
  name: string;
  provider: string;
  reasoning: boolean;
  supportedThinkingLevels: readonly string[];
}

interface BuildPiAvailableModelsArgs {
  models: readonly PiCatalogModel[];
  scopedModelIds?: readonly string[];
  preferredDefaultId?: string;
}

interface BuildPiAvailableModelsResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

const DATE_SUFFIX_PATTERN = /-\d{8}$/;

function isModelAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !DATE_SUFFIX_PATTERN.test(id);
}

function buildPiAvailableModel(model: PiCatalogModel): AvailableModel {
  const supportedReasoningEfforts = getPiReasoningEfforts(model);
  const defaultReasoningEffort =
    supportedReasoningEfforts.find(
      ({ reasoningEffort }) => reasoningEffort === "medium",
    )?.reasoningEffort ??
    supportedReasoningEfforts.find(
      ({ reasoningEffort }) => reasoningEffort !== "none",
    )?.reasoningEffort ??
    supportedReasoningEfforts[0]?.reasoningEffort ??
    "none";
  return {
    id: model.id,
    model: model.id,
    displayName: model.name,
    routeProviderId: "vrata",
    description: describePiModel(model),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: false,
  };
}

export function buildPiAvailableModels(
  args: BuildPiAvailableModelsArgs,
): BuildPiAvailableModelsResult {
  const scopedModelIds = args.scopedModelIds;
  const scopedIds =
    scopedModelIds && scopedModelIds.length > 0
      ? new Set(scopedModelIds)
      : undefined;
  const sourceModels = scopedIds
    ? [...scopedIds].flatMap((id) => {
        const match = args.models.find(
          (model) => toCanonicalPiModelId(model.provider, model.id) === id,
        );
        return match ? [match] : [];
      })
    : args.models;

  const models: AvailableModel[] = [];
  const selectedOnlyModels: AvailableModel[] = [];
  for (const model of sourceModels) {
    const built = buildPiAvailableModel(model);
    if (isModelAlias(model.id) || scopedIds?.has(toCanonicalPiModelId(model.provider, model.id))) {
      models.push(built);
    } else {
      selectedOnlyModels.push(built);
    }
  }

  const preferred = args.models.find((model) => toCanonicalPiModelId(model.provider, model.id) === args.preferredDefaultId)?.id;
  const defaultId = (models.some((model) => model.id === preferred) ? preferred : undefined) ?? models[0]?.id;
  return {
    models: models.map((model) =>
      model.id === defaultId ? { ...model, isDefault: true } : model,
    ),
    selectedOnlyModels,
  };
}

export function toCanonicalPiModelId(
  provider: string,
  modelId: string,
): string {
  return `${provider}/${modelId}`;
}

function getPiReasoningEfforts(model: PiCatalogModel): ModelReasoningEffort[] {
  const supportedLevels = new Set(model.supportedThinkingLevels);
  const efforts: ModelReasoningEffort[] = [];
  if (supportedLevels.has("off")) efforts.push(NONE_REASONING_EFFORT);
  if (supportedLevels.has("low")) efforts.push(LOW_REASONING_EFFORT);
  if (supportedLevels.has("medium")) efforts.push(MEDIUM_REASONING_EFFORT);
  if (supportedLevels.has("high")) efforts.push(HIGH_REASONING_EFFORT);
  if (supportedLevels.has("xhigh")) efforts.push(XHIGH_REASONING_EFFORT);
  if (supportedLevels.has("max")) efforts.push(MAX_REASONING_EFFORT);
  return efforts.length > 0 ? efforts : [NONE_REASONING_EFFORT];
}

function describePiModel(model: PiCatalogModel): string {
  const capabilities: string[] = [];
  capabilities.push(model.reasoning ? "reasoning" : "non-reasoning");
  if (model.input.includes("image")) {
    capabilities.push("multimodal");
  }

  const provider =
    model.provider.length > 0
      ? model.provider[0].toUpperCase() + model.provider.slice(1)
      : model.provider;
  return `${provider} ${capabilities.join(", ")} model via Pi`;
}
