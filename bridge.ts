import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_JSON_RPC_ERRORS, BRIDGE_NOTIFICATION_METHODS, PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_NOTIFICATION_METHOD, createBridgeIo,
  experimental_defineProviderBridge, initializeParamsSchema, modelListParamsSchema,
  providerMaintenanceParamsSchema, runBridgeRequest, threadResumeParamsSchema,
  threadStartParamsSchema, threadStopParamsSchema, turnStartParamsSchema,
  turnSteerParamsSchema, type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { apiBaseUrl, fetchModels, piModel, type VrataConfig, type VrataModel } from "./vrata.js";

type Id = string | number;
type Params = Record<string, unknown>;
interface Session {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  agent?: Agent;
  model?: VrataModel;
  requestedModelId?: string;
  messages: AgentMessage[];
  instructions?: string;
  instructionMode?: "append" | "replace";
  activeInteractionId?: string;
  closed: boolean;
  busy: boolean;
  failed: boolean;
  messageIndex: number;
  messageKey?: string;
  text: string;
  toolArgs: Map<string, { name: string; args: unknown }>;
}

const io = createBridgeIo<{ jsonrpc: "2.0"; method: string; params: Params }>();
const sessions = new Map<string, Session>();
const pendingInteractions = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
let dataDir: string | undefined;

function notify(method: string, params: Params): void {
  io.send({ jsonrpc: "2.0", method, params });
}
function delta(session: Session, ...deltas: ThreadDelta[]): void {
  if (!session.closed && deltas.length) notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId: session.threadId, deltas });
}
function configPath(): string {
  if (!dataDir) throw new Error("Рантайм Врата AI не инициализирован");
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
  const value = getConfig();
  if (!value) throw new Error("Добавьте ключ API Врата AI в настройках плагина");
  return value;
}
function sessionFile(id: string): string {
  if (!dataDir || !/^[0-9a-f-]{36}$/i.test(id) || basename(id) !== id) throw new Error("Некорректный идентификатор сессии");
  return join(dataDir, "sessions", `${id}.json`);
}
function save(session: Session): void {
  const file = sessionFile(session.providerThreadId);
  mkdirSync(join(dataDir!, "sessions"), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ cwd: session.cwd, messages: session.agent?.state.messages ?? session.messages }), { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    // A failed write leaves the last complete transcript in place.
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* ignored */ }
  }
}

function inputText(input: readonly { type: string; text?: string }[]): string {
  return input.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}
function messageText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}
function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").slice(0, 32_000);
}
function onAgentEvent(session: Session, event: AgentEvent): void {
  if (session.closed) return;
  switch (event.type) {
    case "message_start":
      if (event.message.role === "assistant") {
        session.messageIndex += 1;
        session.messageKey = `message-${session.messageIndex}`;
        session.text = "";
        delta(session, { kind: "item.open", key: { providerItemId: session.messageKey }, item: { type: "agentMessage", text: "" } });
      }
      break;
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && session.messageKey) {
        session.text += update.delta;
        delta(session, { kind: "item.textDelta", key: { providerItemId: session.messageKey }, channel: "agentMessage", text: update.delta });
      }
      break;
    }
    case "message_end":
      if (event.message.role === "assistant" && session.messageKey) {
        const text = messageText(event.message);
        delta(session, { kind: "item.textClose", key: { providerItemId: session.messageKey }, channel: "agentMessage", text });
        session.messageKey = undefined;
        if (event.message.stopReason === "error") session.failed = true;
      }
      break;
    case "tool_execution_start":
      session.toolArgs.set(event.toolCallId, { name: event.toolName, args: event.args });
      delta(session, { kind: "item.open", key: { providerItemId: event.toolCallId }, item: { type: "tool", tool: event.toolName, args: event.args } });
      break;
    case "tool_execution_end": {
      const tool = session.toolArgs.get(event.toolCallId);
      session.toolArgs.delete(event.toolCallId);
      delta(session, { kind: "item.close", key: { providerItemId: event.toolCallId }, status: event.isError ? "failed" : "completed", item: { type: "tool", tool: event.toolName, args: tool?.args ?? {}, result: toolResultText(event.result) } });
      break;
    }
  }
}
function newSession(args: { threadId: string; providerThreadId: string; cwd: string; modelId?: string; messages?: AgentMessage[]; instructions?: string; instructionMode?: "append" | "replace" }): Session {
  const session: Session = { threadId: args.threadId, providerThreadId: args.providerThreadId, cwd: args.cwd, requestedModelId: args.modelId, messages: args.messages ?? [], instructions: args.instructions, instructionMode: args.instructionMode, closed: false, busy: false, failed: false, messageIndex: 0, text: "", toolArgs: new Map() };
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId: args.threadId, providerThreadId: args.providerThreadId });
  delta(session, { kind: "session.reset" });
  return session;
}

async function ensureAgent(session: Session, modelId?: string): Promise<Agent> {
  const id = (modelId ?? session.requestedModelId)?.replace(/^vrata\//, "");
  if (session.agent && (!id || id === "vrata-auto" || id === session.model?.id)) return session.agent;
  const config = requiredConfig();
  const models = await fetchModels(config);
  const model = (id && id !== "vrata-auto" && models.find((candidate) => candidate.id === id)) || (id === "vrata-auto" || !id ? models.find((candidate) => candidate.tools) || models[0] : undefined);
  if (!model) throw new Error(id && id !== "vrata-auto" ? `Модель ${id} недоступна для этого ключа` : "Для этого ключа нет доступных моделей Врата AI");
  if (session.agent) {
    session.model = model;
    session.agent.state.model = piModel(model, config);
    session.agent.state.tools = model.tools ? createCodingTools(session.cwd) : [];
    return session.agent;
  }
  const basePrompt = "You are Pi, a coding agent. Work in the current project directory. Read the repository instructions before changing files. Explain significant changes and verify your work.";
  const systemPrompt = session.instructions?.trim()
    ? session.instructionMode === "replace" ? session.instructions : `${basePrompt}\n\n${session.instructions}`
    : basePrompt;
  const agent = new Agent({
    streamFn: streamSimple,
    getApiKey: () => requiredConfig().apiKey,
    initialState: {
      model: piModel(model, config),
      thinkingLevel: "medium",
      systemPrompt,
      tools: model.tools ? createCodingTools(session.cwd) : [],
      messages: session.messages,
    },
  });
  session.agent = agent;
  session.model = model;
  agent.subscribe((event) => onAgentEvent(session, event));
  return agent;
}

function requestKey(session: Session): Promise<void> {
  const id = `key-${randomUUID()}`;
  session.activeInteractionId = id;
  return new Promise<unknown>((resolve, reject) => {
    pendingInteractions.set(id, { resolve, reject });
    io.send({ jsonrpc: "2.0", id, method: "interaction/request", params: {
      providerThreadId: session.providerThreadId,
      threadId: session.threadId,
      turnId: null,
      payload: { kind: "vrata/api-key", title: "Ключ API Врата AI", data: {} },
    } });
  }).then((answer) => {
    const result = z.object({ kind: z.literal("request_answer"), value: z.object({ configured: z.literal(true) }) }).safeParse(answer);
    if (!result.success || !getConfig()) throw new Error("Ключ Врата AI не сохранён. Повторите настройку.");
  }).finally(() => { session.activeInteractionId = undefined; });
}
async function runTurn(session: Session, input: readonly { type: string; text?: string }[], clientRequestId?: string, modelId?: string): Promise<void> {
  if (session.busy) throw new Error("Pi уже выполняет запрос");
  session.busy = true;
  session.failed = false;
  delta(session, ...(clientRequestId ? [{ kind: "input.accepted", clientRequestId } as ThreadDelta] : []), { kind: "turn.open" });
  try {
    const prompt = inputText(input);
    if (!prompt.trim()) throw new Error("Пустой запрос");
    if (!getConfig()) await requestKey(session);
    if (session.closed) return;
    const agent = await ensureAgent(session, modelId);
    await agent.prompt(prompt);
  } catch (error) {
    session.failed = true;
    const text = error instanceof Error ? error.message : String(error);
    const key = `error-${randomUUID()}`;
    delta(session,
      { kind: "item.open", key: { providerItemId: key }, item: { type: "agentMessage", text: "" } },
      { kind: "item.textDelta", key: { providerItemId: key }, channel: "agentMessage", text },
      { kind: "item.textClose", key: { providerItemId: key }, channel: "agentMessage", text });
  } finally {
    session.busy = false;
    if (!session.closed) {
      try { save(session); } catch { /* session remains live; next turn retries persistence */ }
      delta(session, { kind: "turn.boundary", status: session.failed ? "failed" : "completed" });
    }
  }
}

function replyInvalid(id: Id, method: string, issues: unknown): void {
  io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${method}`, { issues });
}
async function request(id: Id, method: string, params: unknown): Promise<void> {
  switch (method) {
    case "initialize": {
      const parsed = initializeParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      io.sendResult(id, { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: { grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3], sessionRestore: true, threadArchive: false, threadRename: false, threadGoalClear: false, fork: "none", approvalEnforcedBy: "runtime", steerMode: "inject" } });
      return;
    }
    case "model/list": {
      const parsed = modelListParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const config = getConfig();
      const models = config ? await fetchModels(config) : [];
      io.sendResult(id, { models: [{ id: "vrata-auto", model: "vrata-auto", displayName: "Авто · Врата AI", routeProviderId: "vrata", description: "Pi выберет доступную модель; ключ запрашивается в треде", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Стандартный режим" }], defaultReasoningEffort: "medium", isDefault: true }, ...models.map((model) => ({ id: model.id, model: model.id, displayName: model.name, routeProviderId: "vrata", description: model.tools ? "Pi: код и инструменты" : "Pi: текст", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Стандартный режим" }], defaultReasoningEffort: "medium", isDefault: false }))], selectedOnlyModels: [] });
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
        catch (error) { status = "unknown"; statusMessage = error instanceof Error ? error.message : String(error); }
      }
      io.sendResult(id, { supported: true, health: { status, statusMessage, accountEmail: null, planLabel: null, installedVersion: "Pi 0.84.0 (bundled)", minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
      return;
    }
    case "thread/start": {
      const parsed = threadStartParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const value = parsed.data;
      const providerThreadId = randomUUID();
      const session = newSession({ threadId: value.threadId, providerThreadId, cwd: value.cwd, modelId: value.options.model, instructions: value.options.instructions, instructionMode: value.instructionMode });
      io.sendResult(id, { providerThreadId, sessionRestorable: true });
      if (value.input?.length) void runTurn(session, value.input);
      return;
    }
    case "thread/resume": {
      const parsed = threadResumeParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const value = parsed.data;
      const file = sessionFile(value.providerThreadId);
      const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { cwd?: string; messages?: AgentMessage[] } : {};
      const session = newSession({ threadId: value.threadId, providerThreadId: value.providerThreadId, cwd: value.cwd, modelId: value.options.model, messages: Array.isArray(saved.messages) ? saved.messages : [], instructions: value.options.instructions, instructionMode: value.instructionMode });
      io.sendResult(id, { providerThreadId: session.providerThreadId, sessionRestorable: true });
      return;
    }
    case "turn/start": {
      const parsed = turnStartParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      if (!session) throw new Error("Сессия Pi не найдена");
      if (session.busy) throw new Error("Pi уже выполняет запрос");
      io.sendResult(id, {});
      void runTurn(session, parsed.data.input, parsed.data.clientRequestId, parsed.data.options.model);
      return;
    }
    case "turn/steer": {
      const parsed = turnSteerParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      if (!session?.busy) return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active turn");
      if (!session.agent) throw new Error("Сначала введите ключ Врата AI в форме треда");
      session.agent.steer({ role: "user", content: inputText(parsed.data.input), timestamp: Date.now() });
      io.sendResult(id, {});
      return;
    }
    case "thread/stop": {
      const parsed = threadStopParamsSchema.safeParse(params);
      if (!parsed.success) return replyInvalid(id, method, parsed.error.issues);
      const session = sessions.get(parsed.data.threadId);
      if (session) {
        if (parsed.data.intent === "release") session.closed = true;
        if (session.activeInteractionId) {
          const pending = pendingInteractions.get(session.activeInteractionId);
          pendingInteractions.delete(session.activeInteractionId);
          pending?.reject(new Error("Тред остановлен"));
        }
        session.agent?.abort();
        await session.agent?.waitForIdle();
        session.closed = true;
        sessions.delete(parsed.data.threadId);
      }
      io.sendResult(id, {});
      return;
    }
    default:
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function handleLine(line: string): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const answer = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() }).safeParse(value);
  if (answer.success && typeof answer.data.id === "string" && pendingInteractions.has(answer.data.id)) {
    const pending = pendingInteractions.get(answer.data.id)!;
    pendingInteractions.delete(answer.data.id);
    if (answer.data.error) pending.reject(new Error(answer.data.error.message));
    else pending.resolve(answer.data.result);
    return;
  }
  const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() }).safeParse(value);
  if (!envelope.success) return;
  const { id, method, params } = envelope.data;
  runBridgeRequest({ request: { id, method, params }, sendError: io.sendError, handleRequest: async () => request(id, method, params) });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) { dataDir = context.dataDir; },
  onClose() { for (const pending of pendingInteractions.values()) pending.reject(new Error("Рантайм закрыт")); pendingInteractions.clear(); for (const session of sessions.values()) session.agent?.abort(); sessions.clear(); },
});
