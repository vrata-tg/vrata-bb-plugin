import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { createCodingTools, estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_JSON_RPC_ERRORS, BRIDGE_NOTIFICATION_METHODS, PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_NOTIFICATION_METHOD, ZERO_TOKEN_USAGE, addTokenUsage,
  createBridgeIo, createPendingToolCallTracker, decodeBridgeJsonRpcResponse,
  experimental_buildBridgeToolCallContent, experimental_defineProviderBridge,
  initializeParamsSchema, modelListParamsSchema, providerMaintenanceParamsSchema,
  runBridgeRequest, threadResumeParamsSchema, threadStartParamsSchema, threadStopParamsSchema,
  turnStartParamsSchema, turnSteerParamsSchema, type DynamicTool, type PromptInput,
  type ThreadDelta, type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { apiBaseUrl, fetchModels, piModel, supportedReasoningLevels, type VrataConfig, type VrataModel, type VrataReasoningLevel } from "./vrata.js";
import { streamVrata } from "./transport.js";
import { buildUserMessage, InputError } from "./bridge-input.js";
import { createImageReadTool } from "./image-runtime.js";
import { CONTEXT_LIMIT_MESSAGE, createTurnOutput, emitError, providerErrorMessage, tokenUsage } from "./bridge-events.js";

type ReasoningLevel = VrataReasoningLevel;
const reasoningEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const effortDescriptions = { none: "Без рассуждений", low: "Низкий", medium: "Средний", high: "Высокий", xhigh: "Очень высокий", max: "Максимальный" };
function defaultReasoningLevel(levels: ReasoningLevel[]): ReasoningLevel {
  return levels.includes("medium") ? "medium" : levels[0];
}
type Id = string | number;
type Params = Record<string, unknown>;

interface Turn {
  controller: AbortController;
  done?: Promise<void>;
  agent?: Agent;
  output: ReturnType<typeof createTurnOutput>;
  interruptedMessages?: AgentMessage[];
  interactionId?: string;
  failed: boolean;
  httpStatus?: number;
  acceptingSteer: boolean;
  pendingSteers: UserMessage[];
}
interface SavedSession {
  messages: AgentMessage[];
  selectedModelId?: string;
  selectedReasoningLevel?: ReasoningLevel;
  totalUsage?: ThreadEventTokenUsageBreakdown;
}
interface Session {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  requestedModelId?: string;
  selectedReasoningLevel?: ReasoningLevel;
  messages: AgentMessage[];
  totalUsage: ThreadEventTokenUsageBreakdown;
  instructions?: string;
  instructionMode: "append" | "replace";
  dynamicTools: DynamicTool[];
  disallowedTools: string[];
  active?: Turn;
  stopping?: Promise<void>;
  silent: boolean;
  closed: boolean;
}

const io = createBridgeIo<{ jsonrpc: "2.0"; method: string; params: Params }>();
const sessions = new Map<string, Session>();
const pendingInteractions = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
const toolCalls = createPendingToolCallTracker({ sendToolCall: (request) => io.send(request) });
let dataDir: string | undefined;
let runtimeGeneration = 0;
let runtimeClosed = false;

function notify(method: string, params: Params): void { io.send({ jsonrpc: "2.0", method, params }); }
function delta(session: Session, ...deltas: ThreadDelta[]): void {
  if (!session.closed && !session.silent && deltas.length) notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId: session.threadId, deltas });
}
function configPath(): string {
  if (!dataDir) throw new InputError("Рантайм Врата AI не инициализирован");
  return join(dataDir, "credentials.json");
}
function getConfig(): VrataConfig | undefined {
  if (!existsSync(configPath())) return undefined;
  const value: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
  if (!value || typeof value !== "object") return undefined;
  const config = value as Partial<VrataConfig>;
  if (typeof config.apiKey !== "string" || !config.apiKey || typeof config.baseUrl !== "string") return undefined;
  apiBaseUrl(config.baseUrl);
  return config as VrataConfig;
}
function requiredConfig(): VrataConfig {
  const config = getConfig();
  if (!config) throw new InputError("Добавьте ключ API Врата AI в настройках плагина");
  return config;
}
function sessionFile(id: string): string {
  if (!dataDir || !/^[0-9a-f-]{36}$/i.test(id) || basename(id) !== id) throw new InputError("Некорректный идентификатор сессии");
  return join(dataDir, "sessions", `${id}.json`);
}
function save(session: Session): void {
  const file = sessionFile(session.providerThreadId);
  mkdirSync(join(dataDir!, "sessions"), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const saved: SavedSession = { messages: session.messages, selectedModelId: session.requestedModelId, selectedReasoningLevel: session.selectedReasoningLevel, totalUsage: session.totalUsage };
  try {
    writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* Preserve the previous atomic snapshot. */ }
  }
}
function newSession(value: z.infer<typeof threadStartParamsSchema>, providerThreadId: string, saved?: SavedSession): Session {
  const explicitModel = value.options.model && value.options.model !== "vrata-setup";
  const messages = saved?.messages ?? [];
  const totalUsage = saved?.totalUsage ?? messages.reduce((total, message) => message.role === "assistant" ? addTokenUsage(total, tokenUsage(message.usage)) : total, { ...ZERO_TOKEN_USAGE });
  const session: Session = {
    threadId: value.threadId, providerThreadId, cwd: value.cwd,
    requestedModelId: explicitModel ? value.options.model : saved?.selectedModelId ?? value.options.model,
    selectedReasoningLevel: explicitModel ? value.options.reasoningLevel as ReasoningLevel | undefined : saved?.selectedReasoningLevel,
    messages, totalUsage, instructions: value.options.instructions, instructionMode: value.instructionMode,
    dynamicTools: value.dynamicTools ?? [], disallowedTools: value.disallowedTools ?? [], silent: false, closed: false,
  };
  sessions.set(value.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId: value.threadId, providerThreadId });
  delta(session, { kind: "session.reset" });
  return session;
}
function checkTurn(session: Session, turn: Turn): void {
  turn.controller.signal.throwIfAborted();
  if (session.closed || session.active !== turn) throw new Error("Turn is no longer active");
}
function requestInteraction(session: Session, turn: Turn, payload: Params): Promise<unknown> {
  checkTurn(session, turn);
  const id = `interaction-${randomUUID()}`;
  turn.interactionId = id;
  return new Promise<unknown>((resolve, reject) => {
    pendingInteractions.set(id, { resolve, reject });
    io.send({ jsonrpc: "2.0", id, method: "interaction/request", params: {
      providerThreadId: session.providerThreadId, threadId: session.threadId, turnId: null, payload,
    } });
  }).finally(() => { pendingInteractions.delete(id); turn.interactionId = undefined; });
}
async function selectModel(session: Session, turn: Turn, config: VrataConfig, models: VrataModel[]): Promise<{ modelId: string; reasoningLevel: ReasoningLevel }> {
  checkTurn(session, turn);
  if (!models.length) throw new InputError("Для этого ключа нет доступных моделей Врата AI");
  const answer = await requestInteraction(session, turn, { kind: "vrata/model", title: "Выберите модель Врата AI", data: {
    models: models.map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning, reasoningLevels: supportedReasoningLevels(piModel(model, config)) })),
  } });
  checkTurn(session, turn);
  const parsed = z.object({ kind: z.literal("request_answer"), value: z.object({ modelId: z.string(), reasoningLevel: z.enum(reasoningEfforts) }) }).safeParse(answer);
  if (!parsed.success || !models.some((model) => model.id === parsed.data.value.modelId)) throw new InputError("Выберите доступную модель Врата AI");
  return parsed.data.value;
}
function toolsFor(session: Session, turn: Turn): AgentTool[] {
  const dynamic: AgentTool[] = session.dynamicTools.map((tool) => ({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: tool.inputSchema as AgentTool["parameters"],
    async execute(_id, args, signal) {
      checkTurn(session, turn);
      signal?.throwIfAborted();
      const result = await toolCalls.forwardToolCall({ arguments: args as Record<string, unknown>, providerThreadId: session.providerThreadId, scope: turn, threadId: session.threadId, toolName: tool.name });
      checkTurn(session, turn);
      signal?.throwIfAborted();
      return { content: experimental_buildBridgeToolCallContent(result), details: { isError: result.isError } };
    },
  }));
  const tools = new Map(createCodingTools(session.cwd).map((tool) => [tool.name, tool]));
  tools.set("read", createImageReadTool(session.cwd));
  for (const tool of dynamic) tools.set(tool.name, tool);
  return [...tools.values()].filter((tool) => !session.disallowedTools.includes(tool.name));
}
function abortTurn(session: Session): void {
  const turn = session.active;
  if (!turn || turn.controller.signal.aborted) return;
  // Snapshot before abort listeners or late transport results can mutate Pi's state.
  const messages = turn.agent?.state.messages ?? session.messages;
  const streaming = turn.agent?.state.streamingMessage;
  turn.interruptedMessages = structuredClone([
    ...messages,
    ...(streaming?.role === "assistant" ? [{ ...streaming, stopReason: "aborted" as const }] : []),
    ...turn.pendingSteers,
  ]);
  for (const message of turn.interruptedMessages) {
    if (message.role === "assistant" && message.errorMessage) message.errorMessage = providerErrorMessage(message.errorMessage, turn.httpStatus);
  }
  turn.controller.abort();
  turn.output.close("interrupted");
  if (turn.interactionId) {
    const pending = pendingInteractions.get(turn.interactionId);
    pendingInteractions.delete(turn.interactionId);
    pending?.reject(new Error("Тред остановлен"));
  }
  toolCalls.resolvePendingToolCalls(turn, "Тред остановлен");
  turn.agent?.abort();
}
async function stopSession(session: Session, release: boolean): Promise<void> {
  if (release) session.silent = true;
  if (!session.stopping) {
    abortTurn(session);
    session.stopping = (async () => { await session.active?.done; })().finally(() => { session.stopping = undefined; });
  }
  await session.stopping;
  if (release) {
    session.closed = true;
    if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
  }
}
function beginTurn(session: Session, input: readonly PromptInput[], clientRequestId?: string, modelId?: string, reasoningLevel?: ReasoningLevel): void {
  if (session.active || session.stopping || session.closed) throw new InputError("Pi уже выполняет запрос или останавливается");
  const emit = (...deltas: ThreadDelta[]) => delta(session, ...deltas);
  const turn: Turn = {
    controller: new AbortController(), failed: false, acceptingSteer: false, pendingSteers: [],
    output: createTurnOutput({
      emit, onError: () => { turn.failed = true; }, httpStatus: () => turn.httpStatus,
      presentation: (name) => session.dynamicTools.find((tool) => tool.name === name)?.presentation,
      onUsage: (usage) => {
        const last = tokenUsage(usage);
        session.totalUsage = addTokenUsage(session.totalUsage, last);
        emit({ kind: "usage", last, total: session.totalUsage, modelContextWindow: turn.agent?.state.model.contextWindow ?? null });
      },
    }),
  };
  session.active = turn;
  // Reserve the turn synchronously, including the configuration and attachment preparation.
  turn.done = runTurn(session, turn, input, clientRequestId, modelId, reasoningLevel);
}
async function runTurn(session: Session, turn: Turn, input: readonly PromptInput[], clientRequestId?: string, modelId?: string, reasoningLevel?: ReasoningLevel): Promise<void> {
  const emit = (...deltas: ThreadDelta[]) => delta(session, ...deltas);
  emit(...(clientRequestId ? [{ kind: "input.accepted", clientRequestId } as ThreadDelta] : []), { kind: "turn.open" });
  try {
    checkTurn(session, turn);
    if (!getConfig()) {
      const answer = await requestInteraction(session, turn, { kind: "vrata/api-key", title: "Ключ API Врата AI", data: {} });
      checkTurn(session, turn);
      if (!z.object({ kind: z.literal("request_answer"), value: z.object({ configured: z.literal(true) }) }).safeParse(answer).success) throw new InputError("Ключ Врата AI не сохранён. Повторите настройку.");
    }
    const config = requiredConfig();
    const models = await fetchModels(config, turn.controller.signal);
    checkTurn(session, turn);
    let selectedModel = (modelId && modelId !== "vrata-setup" ? modelId : session.requestedModelId)?.replace(/^vrata\//, "");
    let selectedReasoning = modelId === "vrata-setup" ? session.selectedReasoningLevel : reasoningLevel ?? session.selectedReasoningLevel;
    if (!selectedModel || selectedModel === "vrata-setup") {
      const selected = await selectModel(session, turn, config, models);
      selectedModel = selected.modelId;
      selectedReasoning = selected.reasoningLevel;
    }
    const model = models.find((candidate) => candidate.id === selectedModel);
    if (!model) throw new InputError("Выбранная модель недоступна для этого ключа");
    const pi = piModel(model, config);
    const levels = supportedReasoningLevels(pi);
    selectedReasoning ??= defaultReasoningLevel(levels);
    if (!levels.includes(selectedReasoning)) throw new InputError("Выбранный уровень ризонинга не поддерживается моделью. Выберите доступный уровень.");
    session.requestedModelId = selectedModel;
    session.selectedReasoningLevel = selectedReasoning;
    const message = await buildUserMessage(input, session.cwd, model.images, turn.controller.signal);
    checkTurn(session, turn);
    const basePrompt = "You are Pi, a coding agent. Work in the current project directory. Read the repository instructions before changing files. Explain significant changes and verify your work.";
    const systemPrompt = session.instructions?.trim()
      ? session.instructionMode === "replace" ? session.instructions : `${basePrompt}\n\n${session.instructions}` : basePrompt;
    const agent = new Agent({
      streamFn: (currentModel, context, options) => {
        checkTurn(session, turn);
        options?.signal?.throwIfAborted();
        const used = context.messages.reduce((total, item) => total + estimateTokens(item), 0)
          + Math.ceil(((context.systemPrompt?.length ?? 0) + JSON.stringify(context.tools ?? []).length) / 4);
        emit({ kind: "contextWindow", attach: "open", used, size: currentModel.contextWindow, estimated: true });
        // Pi fits the output cap to the remaining context; a model's maximum
        // output can equal its whole window, so reserve a bounded answer budget.
        const outputReserve = Math.min(currentModel.maxTokens, 4096);
        if (used + outputReserve >= currentModel.contextWindow) throw new Error(CONTEXT_LIMIT_MESSAGE);
        turn.httpStatus = undefined;
        return streamVrata(currentModel, context, { ...options, signal: AbortSignal.any([turn.controller.signal, ...(options?.signal ? [options.signal] : [])]), onResponse: (response, responseModel) => {
          turn.httpStatus = response.status;
          return options?.onResponse?.(response, responseModel);
        } });
      },
      getApiKey: () => config.apiKey,
      afterToolCall: async ({ toolCall, result }) => {
        if (session.dynamicTools.some((tool) => tool.name === toolCall.name) && result.details?.isError === true) {
          return { isError: true };
        }
      },
      initialState: { model: pi, thinkingLevel: selectedReasoning === "none" ? "off" : selectedReasoning,
        systemPrompt, tools: model.tools ? toolsFor(session, turn) : [], messages: session.messages },
    });
    turn.agent = agent;
    agent.subscribe((event) => {
      if (event.type === "agent_start") turn.acceptingSteer = true;
      if (event.type === "agent_end") turn.acceptingSteer = false;
      if (event.type === "message_start" && event.message.role === "user") {
        turn.pendingSteers = turn.pendingSteers.filter((message) => message !== event.message);
      }
      if (!session.closed && !turn.controller.signal.aborted) turn.output.onEvent(event);
    });
    checkTurn(session, turn);
    await agent.prompt(message);
  } catch (error) {
    if (!turn.controller.signal.aborted) {
      turn.failed = true;
      emitError(emit, error instanceof InputError ? error.message : providerErrorMessage(undefined, turn.httpStatus));
    }
  } finally {
    if (!session.closed) {
      session.messages = turn.interruptedMessages ?? turn.agent?.state.messages ?? session.messages;
      try { save(session); }
      catch { turn.failed = true; emitError(emit, "Не удалось сохранить историю треда. Проверьте доступ к диску перед закрытием."); }
      const status = turn.controller.signal.aborted ? "interrupted" : turn.failed ? "failed" : "completed";
      turn.output.close(status);
      emit({ kind: "turn.boundary", status });
    }
    if (session.active === turn) session.active = undefined;
  }
}
function replyInvalid(id: Id, method: string, issues: unknown): void {
  io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${method}`, { issues });
}
async function request(id: Id, method: string, params: unknown): Promise<void> {
  const generation = runtimeGeneration;
  const isCurrent = () => !runtimeClosed && generation === runtimeGeneration;
  const reply = (result: unknown) => {
    if (isCurrent()) io.sendResult(id, result);
  };
  switch (method) {
    case "initialize": {
      const parsed = initializeParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      reply({ protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: { grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3], sessionRestore: true, threadArchive: false, threadRename: false, threadGoalClear: false, fork: "none", approvalEnforcedBy: "runtime", steerMode: "inject" } });
      return;
    }
    case "model/list": {
      const parsed = modelListParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const config = getConfig();
      const models = config ? await fetchModels(config) : [];
      reply({ models: config ? models.map((model, index) => {
        const levels = supportedReasoningLevels(piModel(model, config));
        return { id: model.id, model: model.id, displayName: model.name, routeProviderId: "vrata", description: model.tools ? "Pi: код и инструменты" : "Pi: текст", supportedReasoningEfforts: levels.map((level) => ({ reasoningEffort: level, description: effortDescriptions[level] })), defaultReasoningEffort: defaultReasoningLevel(levels), isDefault: index === 0 };
      }) : [{ id: "vrata-setup", model: "vrata-setup", displayName: "Ввести ключ и выбрать модель", routeProviderId: "vrata", description: "Настройка в треде", supportedReasoningEfforts: [{ reasoningEffort: "none", description: effortDescriptions.none }], defaultReasoningEffort: "none", isDefault: true }], selectedOnlyModels: [] });
      return;
    }
    case "provider/health": {
      const parsed = providerMaintenanceParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const config = getConfig();
      let status: "ready" | "unknown" = "ready";
      let statusMessage: string | null = "Ключ будет запрошен при первом обращении в треде";
      if (config) {
        try { const models = await fetchModels(config); status = models.length ? "ready" : "unknown"; statusMessage = models.length ? null : "Нет доступных моделей"; }
        catch (error) { status = "unknown"; statusMessage = providerErrorMessage(error instanceof Error ? error.message : undefined); }
      }
      reply({ supported: true, health: { status, statusMessage, accountEmail: null, planLabel: null, installedVersion: "Pi 0.84.0 (bundled)", minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
      return;
    }
    case "thread/start": {
      const parsed = threadStartParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const value = parsed.data;
      for (let previous = sessions.get(value.threadId); previous; previous = sessions.get(value.threadId)) {
        await stopSession(previous, true);
        if (!isCurrent()) return;
      }
      if (!isCurrent()) return;
      const session = newSession(value, randomUUID());
      reply({ providerThreadId: session.providerThreadId, sessionRestorable: true });
      if (value.input?.length) beginTurn(session, value.input, undefined, value.options.model, value.options.reasoningLevel as ReasoningLevel | undefined);
      return;
    }
    case "thread/resume": {
      const parsed = threadResumeParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const value = parsed.data;
      for (let previous = sessions.get(value.threadId); previous; previous = sessions.get(value.threadId)) {
        await stopSession(previous, true);
        if (!isCurrent()) return;
      }
      if (!isCurrent()) return;
      const file = sessionFile(value.providerThreadId);
      const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as SavedSession : undefined;
      const session = newSession(value, value.providerThreadId, saved);
      reply({ providerThreadId: session.providerThreadId, sessionRestorable: true });
      return;
    }
    case "turn/start": {
      const parsed = turnStartParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const value = parsed.data;
      const session = sessions.get(value.threadId);
      if (!session) throw new InputError("Сессия Pi не найдена");
      if (session.active || session.stopping) throw new InputError("Pi уже выполняет запрос");
      beginTurn(session, value.input, value.clientRequestId, value.options.model, value.options.reasoningLevel as ReasoningLevel | undefined);
      reply({});
      return;
    }
    case "turn/steer": {
      const parsed = turnSteerParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const value = parsed.data;
      const session = sessions.get(value.threadId);
      const turn = session?.active;
      if (!session || !turn || !turn.agent || !turn.acceptingSteer || session.stopping) return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active turn");
      const message = await buildUserMessage(value.input, session.cwd, turn.agent.state.model.input.includes("image"), turn.controller.signal);
      checkTurn(session, turn);
      if (!turn.acceptingSteer) return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active turn");
      turn.pendingSteers.push(message);
      turn.agent.steer(message);
      delta(session, { kind: "input.accepted", clientRequestId: value.clientRequestId });
      reply({});
      return;
    }
    case "thread/stop": {
      const parsed = threadStopParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      if (session) await stopSession(session, parsed.data.intent === "release");
      reply({});
      return;
    }
    default:
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
export function handleLine(line: string): void {
  if (runtimeClosed) return;
  const generation = runtimeGeneration;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const response = decodeBridgeJsonRpcResponse(value);
  if (response) {
    if (toolCalls.handleToolCallResponse(response)) return;
    const pending = typeof response.id === "string" ? pendingInteractions.get(response.id) : undefined;
    if (pending) {
      pendingInteractions.delete(String(response.id));
      if ("error" in response) pending.reject(new Error("Не удалось завершить настройку Врата AI"));
      else pending.resolve(response.result);
    }
    return;
  }
  const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() }).safeParse(value);
  if (!envelope.success) return;
  const { id, method, params } = envelope.data;
  runBridgeRequest({ request: { id, method, params }, sendError: (...args) => {
    if (!runtimeClosed && generation === runtimeGeneration) io.sendError(...args);
  }, handleRequest: async () => {
    try { await request(id, method, params); }
    catch (error) { throw new Error(error instanceof InputError ? error.message : "Не удалось выполнить команду Врата AI"); }
  } });
}
function closeRuntime(): void {
  runtimeClosed = true;
  runtimeGeneration += 1;
  for (const session of sessions.values()) {
    session.silent = true;
    abortTurn(session);
    if (session.active?.interruptedMessages) session.messages = session.active.interruptedMessages;
    try { save(session); } catch { /* Shutdown cannot report through a closed transport. */ }
    session.closed = true;
  }
  sessions.clear();
}
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) { dataDir = context.dataDir; runtimeClosed = false; runtimeGeneration += 1; },
  onClose: closeRuntime,
  onSigterm: closeRuntime,
  onSigint: closeRuntime,
});
