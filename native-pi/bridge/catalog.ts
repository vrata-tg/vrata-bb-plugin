import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { VRATA_PROVIDER_ID } from "../../vrata.js";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { resolve } from "node:path";
import {
  createPiModelContextWindowResolverFrom,
  type PiModelContextWindowResolver,
  type PiContextWindowModel,
} from "../delta-translation.js";
import { buildPiAvailableModels, type PiCatalogModel } from "../model-list.js";
import {
  PiRpcChild,
  PiRpcChildExitedError,
  buildPiChildEnv,
  type PiRuntimeOptions,
} from "./rpc-child.js";

type PiRpcModel = Model<Api>;

function toCatalogModel(model: PiRpcModel): PiCatalogModel | undefined {
  if (
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    typeof model.provider !== "string" ||
    model.provider.length === 0
  ) {
    return undefined;
  }
  return {
    id: model.id,
    input: Array.isArray(model.input)
      ? model.input.filter(
          (entry) => typeof entry === "string",
        )
      : [],
    name: typeof model.name === "string" ? model.name : model.id,
    provider: model.provider,
    reasoning: model.reasoning === true,
    supportedThinkingLevels: getSupportedThinkingLevels(model),
  };
}

export interface PiCatalog {
  listModels(): Promise<{
    models: AvailableModel[];
    selectedOnlyModels: AvailableModel[];
  }>;
  rawModels(): Promise<PiRpcModel[]>;
  close(): Promise<void>;
}

const catalogsByCwd = new Map<string, Promise<PiCatalog>>();

async function spawnCatalog(
  runtime: PiRuntimeOptions,
  cwd: string,
  extensionPath: string,
  touch: () => void,
): Promise<PiCatalog> {
  interface CatalogChildGeneration {
    child: PiRpcChild;
    ready: Promise<Record<string, unknown>>;
    getModelScope():
      | { scopedModelIds: string[]; defaultModelId?: string }
      | undefined;
  }

  let generation: CatalogChildGeneration | null = null;
  const spawnGeneration = (): CatalogChildGeneration => {
    let modelScope:
      | { scopedModelIds: string[]; defaultModelId?: string }
      | undefined;
    let settleModelScopeRequest: (() => void) | undefined;
    const acceptModelScope = (value: Record<string, unknown>): void => {
      const scopedModelIds = Array.isArray(value.scopedModelIds)
        ? value.scopedModelIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      modelScope = {
        scopedModelIds,
        defaultModelId:
          typeof value.defaultModelId === "string"
            ? value.defaultModelId
            : undefined,
      };
    };
    const child = new PiRpcChild({
      launch: runtime.launch,
      cwd,
      env: buildPiChildEnv(runtime.env),
      args: ["--mode", "rpc", "--no-session", "--extension", extensionPath, "--extension", runtime.extensionPath],
      onEvent: () => {},
      onChannelMessage: (message) => {
        if (message.kind === "model-scope") {
          acceptModelScope(message);
          return;
        }
        if (
          message.kind === "reply" &&
          message.id === "catalog-model-scope" &&
          typeof message.result === "object" &&
          message.result !== null
        ) {
          acceptModelScope(message.result as Record<string, unknown>);
          settleModelScopeRequest?.();
          settleModelScopeRequest = undefined;
        }
      },
      onExit: () => {},
      recordThreadId: null,
    });
    const ready = (async (): Promise<Record<string, unknown>> => {
      const data = await child.requestOk({ type: "get_state" });
      await new Promise<void>((resolveScope) => {
        const timeout = setTimeout(resolveScope, 2_000);
        timeout.unref?.();
        settleModelScopeRequest = () => {
          clearTimeout(timeout);
          resolveScope();
        };
        child.sendChannel({
          kind: "request",
          id: "catalog-model-scope",
          method: "model-scope",
        });
      });
      return typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    })();
    return { child, ready, getModelScope: () => modelScope };
  };
  const activeGeneration = (): CatalogChildGeneration => {
    if (generation === null || generation.child.exited) {
      generation = spawnGeneration();
    }
    return generation;
  };
  const fetchRawFrom = async (
    active: CatalogChildGeneration,
  ): Promise<PiRpcModel[]> => {
    await active.ready;
    const data = (await active.child.requestOk({
      type: "get_available_models",
    })) as { models?: unknown[] } | undefined;
    touch();
    return (data?.models ?? []).filter(
      (entry): entry is PiRpcModel =>
        typeof entry === "object" && entry !== null && "provider" in entry && entry.provider === VRATA_PROVIDER_ID,
    );
  };
  const fetchGeneration = async (): Promise<{
    active: CatalogChildGeneration;
    raw: PiRpcModel[];
  }> => {
    const first = activeGeneration();
    try {
      return { active: first, raw: await fetchRawFrom(first) };
    } catch (error) {
      if (!(error instanceof PiRpcChildExitedError)) {
        throw error;
      }
      const active = activeGeneration();
      return { active, raw: await fetchRawFrom(active) };
    }
  };
  const fetchRaw = async (): Promise<PiRpcModel[]> =>
    (await fetchGeneration()).raw;
  const probe = async (): Promise<Record<string, unknown>> =>
    activeGeneration().ready;
  await probe();
  return {
    async listModels() {
      const { active, raw } = await fetchGeneration();
      const models: PiCatalogModel[] = [];
      for (const model of raw) {
        const catalogModel = toCatalogModel(model);
        if (catalogModel) {
          models.push(catalogModel);
        } else {
          process.stderr.write("pi bridge: skipped an incomplete model\n");
        }
      }
      const modelScope = active.getModelScope();
      return buildPiAvailableModels({
        models,
        scopedModelIds: modelScope?.scopedModelIds,
        preferredDefaultId: modelScope?.defaultModelId,
      });
    },
    rawModels: fetchRaw,
    async close() {
      const activeChild = generation?.child;
      if (activeChild === undefined) return;
      activeChild.kill();
      await activeChild.waitForExit();
    },
  };
}

function catalogIdleMs(): number {
  const configured = Number(process.env.BB_PI_CATALOG_IDLE_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 5 * 60_000;
}
const catalogIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function touchCatalog(key: string): void {
  const existing = catalogIdleTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    catalogIdleTimers.delete(key);
    const catalog = catalogsByCwd.get(key);
    catalogsByCwd.delete(key);
    void catalog?.then((entry) => entry.close()).catch(() => undefined);
  }, catalogIdleMs());
  timer.unref?.();
  catalogIdleTimers.set(key, timer);
}

export function peekPiCatalog(cwd: string): Promise<PiCatalog> | null {
  return catalogsByCwd.get(resolve(cwd)) ?? null;
}

export function getPiCatalog(
  runtime: PiRuntimeOptions,
  cwd: string,
  extensionPath: string,
): Promise<PiCatalog> {
  const key = resolve(cwd);
  const existing = catalogsByCwd.get(key);
  if (existing) {
    return existing;
  }
  const created = spawnCatalog(runtime, key, extensionPath, () =>
    touchCatalog(key),
  ).catch((error: unknown) => {
    catalogsByCwd.delete(key);
    throw error;
  });
  catalogsByCwd.set(key, created);
  return created;
}

export async function closeAllPiCatalogs(): Promise<void> {
  for (const [, timer] of catalogIdleTimers) {
    clearTimeout(timer);
  }
  catalogIdleTimers.clear();
  const catalogs = [...catalogsByCwd.values()];
  catalogsByCwd.clear();
  await Promise.all(
    catalogs.map((catalog) =>
      catalog.then((entry) => entry.close()).catch(() => undefined),
    ),
  );
}

export function createLiveContextWindowResolver(): {
  resolve: PiModelContextWindowResolver;
  learn(models: readonly PiContextWindowModel[]): void;
} {
  const known = new Map<string, PiContextWindowModel>();
  let resolver = createPiModelContextWindowResolverFrom([]);
  return {
    resolve: (lastAssistant) => resolver(lastAssistant),
    learn(models) {
      let changed = false;
      for (const model of models) {
        if (typeof model.contextWindow !== "number") {
          continue;
        }
        const key = `${model.provider}\0${model.id}`;
        if (!known.has(key)) {
          known.set(key, model);
          changed = true;
        }
      }
      if (changed) {
        resolver = createPiModelContextWindowResolverFrom(
          [...known.values()].map((model) => ({
            id: model.id,
            provider: model.provider,
            contextWindow: model.contextWindow,
          })),
        );
      }
    },
  };
}
