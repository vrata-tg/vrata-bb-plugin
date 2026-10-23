import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  isStandaloneBuiltinCompactCommand,
  mimeTypeFromExtension,
  modelListParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeToolCallRequest,
  type InitializeResult,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { createPiDeltaTranslator } from "./pi/events.js";
import {
  buildPiSessionParams,
  buildPiTurnOptions,
  type PiSessionParams,
} from "./pi/params.js";
import { BB_PI_EXTENSION_SOURCE } from "./pi/tools.js";
import { preparePiRuntime } from "./pi-runtime.js";
import { ensureLegacySession } from "./legacy-session.js";
import { buildPiModels, readConfig, VRATA_PROVIDER_ID, supportedReasoningLevels, fetchModels, buildPiAvailableModels } from "./vrata.js";
import { createCredentialRedactor } from "./pi/redact.js";
import type { PiRuntimeOptions } from "./pi/child.js";
import {
  PiRpcSession,
  type PiRpcSessionOptions,
} from "./pi/session.js";
import {
  resolvePiSessionFilePath,
} from "./pi/session-paths.js";

const piCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: threadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: threadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: threadForkParamsSchema,
  }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({
    method: z.literal("thread/stop"),
    params: threadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: threadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type PiCommand = z.infer<typeof piCommandSchema>;

const piCommandMethodValues = piCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedPiBridgeRequest =
  | { kind: "request"; request: PiCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodePiJsonRpcRequest(raw: unknown): DecodedPiBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = piCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id },
    };
  }
  if (
    !(piCommandMethodValues as readonly string[]).includes(envelope.data.method)
  ) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface ThreadSession {
  session: PiRpcSession;
  models: Model<Api>[];
  closeTask?: Promise<string | undefined>;
  providerThreadId: string;
  cwd: string;
  translator: ReturnType<typeof createPiDeltaTranslator>;
  admission: Promise<void>;
}

const THREAD_STOP_CLOSE_TIMEOUT_MS = 8_000;

const io = createBridgeIo<
  BridgeEventNotification | BridgeToolCallRequest | { jsonrpc: "2.0"; id: string; method: string; params: Record<string, unknown> }
>();

const send: typeof io.send = (...args) => { if (!bridgeClosed) io.send(...args); };
const sendResult: typeof io.sendResult = (...args) => { if (!bridgeClosed) io.sendResult(...args); };
class SetupError extends Error {}
let redactor: ReturnType<typeof createCredentialRedactor> | undefined;
function safeError(error: unknown): string {
  redactor?.refresh();
  const message = error instanceof Error ? error.message : "Не удалось выполнить запрос Pi";
  return redactor?.text(message) ?? "Не удалось выполнить запрос Pi";
}
function sendError(id: string | number, code: number, message: string): void {
  if (!bridgeClosed) io.sendError(id, code, message);
}
let dataDir: string | undefined;
let runtimePromise: Promise<Awaited<ReturnType<typeof preparePiRuntime>>> | undefined;
let runtime: Awaited<ReturnType<typeof preparePiRuntime>> | undefined;
let bridgeClosed = false;
function requireDataDir(): string {
  if (!dataDir) throw new SetupError("Рантайм Врата AI не инициализирован");
  return dataDir;
}
async function requireRuntime() {
  runtimePromise ??= preparePiRuntime(requireDataDir());
  const prepared = await runtimePromise;
  if (bridgeClosed) throw new SetupError("Рантайм остановлен");
  runtime = prepared;
  return prepared;
}
function childRuntime(models: Model<Api>[]): PiRuntimeOptions {
  if (!runtime) throw new SetupError("Рантайм Врата AI не инициализирован");
  return {
    launch: { command: process.execPath, args: [runtime.rpcEntry] },
    env: { ...runtime.env, VRATA_MODEL_CATALOG: JSON.stringify(models) },
    extensionPath: runtime.extensionPath,
  };
}
function sessionPath(providerThreadId: string): string {
  if (!runtime) throw new SetupError("Рантайм Врата AI не инициализирован");
  return resolvePiSessionFilePath({ sessionDir: runtime.sessionDir, threadId: providerThreadId });
}
function normalizeModel(model: string | undefined): string | undefined {
  if (!model || model === "vrata-setup") return undefined;
  return `${VRATA_PROVIDER_ID}/${model.replace(/^(?:vrata|vrata\.tg)\//, "")}`;
}
const generations = new Map<string, AbortController>();
interface PendingConstruction {
  providerThreadId: string;
  params: PiSessionParams;
  controller: AbortController;
  task?: Promise<void>;
  interactionId?: string;
}
const pendingConstruction = new Map<string, PendingConstruction>();
const pendingInteractions = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function checkCurrent(threadId: string, controller: AbortController): void {
  controller.signal.throwIfAborted();
  if (bridgeClosed || generations.get(threadId) !== controller) throw new SetupError("Тред остановлен");
}
function cancelPending(threadId: string): boolean {
  generations.get(threadId)?.abort();
  generations.delete(threadId);
  const pending = pendingConstruction.get(threadId);
  pendingConstruction.delete(threadId);
  if (pending?.interactionId) {
    const interaction = pendingInteractions.get(pending.interactionId);
    pendingInteractions.delete(pending.interactionId);
    interaction?.reject(new SetupError("Тред остановлен"));
  }
  return pending?.task !== undefined;
}
function requestInteraction(threadId: string, pending: PendingConstruction, payload: Record<string, unknown>): Promise<unknown> {
  checkCurrent(threadId, pending.controller);
  const id = `interaction-${randomUUID()}`;
  pending.interactionId = id;
  return new Promise<unknown>((resolve, reject) => {
    pendingInteractions.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: "interaction/request", params: {
      threadId, providerThreadId: pending.providerThreadId, turnId: null, payload,
    } });
  }).finally(() => {
    pendingInteractions.delete(id);
    if (pending.interactionId === id) pending.interactionId = undefined;
  });
}

const sessions = new Map<string, ThreadSession>();
const { forwardToolCall, handleToolCallResponse, resolvePendingToolCalls } =
  createPendingToolCallTracker({ sendToolCall: send });

let configuredSkillPaths: string[] | null = null;

let scratchDir: string | null = null;
let extensionPath: string | null = null;

function requireScratchDir(): string {
  if (scratchDir === null) throw new SetupError("Рантайм Врата AI не инициализирован");
  return scratchDir;
}

function requireExtensionPath(): string {
  if (extensionPath === null) {
    const path = join(requireScratchDir(), "bb-pi-extension.mjs");
    writeFileSync(path, BB_PI_EXTENSION_SOURCE, "utf8");
    extensionPath = path;
  }
  return extensionPath;
}

function isCurrentSession(threadId: string, session: ThreadSession): boolean {
  return !bridgeClosed && !session.closeTask && sessions.get(threadId) === session;
}

async function closeThreadSession(args: {
  message: string;
  threadId: string;
}): Promise<string | undefined> {
  const entry = sessions.get(args.threadId);
  if (!entry) return;
  entry.closeTask ??= entry.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS).finally(() => {
    // Abort/exit before releasing a tool result, which can start a continuation.
    resolvePendingToolCalls(entry, args.message);
    if (sessions.get(args.threadId) === entry) sessions.delete(args.threadId);
  });
  return entry.closeTask;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(sessions.keys()).map((threadId) =>
      closeThreadSession({ message, threadId }),
    ),
  );
}

function sendThreadDeltas(
  threadId: string,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [...deltas] },
  });
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId, sessionRestorable: true },
  });
}

function sendSessionScopedError(
  threadId: string,
  providerThreadId: string,
  message: string,
): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.error,
    params: { threadId, providerThreadId, message },
  });
}

function reportSessionError(threadId: string, entry: ThreadSession, error: unknown): void {
  if (!isCurrentSession(threadId, entry)) return;
  const message = safeError(error);
  sendThreadDeltas(threadId, [{ kind: "provider.error", message }]);
  sendSessionScopedError(threadId, entry.providerThreadId, message);
}

function emitContextWindowUsage(threadId: string, entry: ThreadSession): void {
  const usage = entry.session.getContextUsage();
  if (usage?.tokens !== null && usage?.tokens !== undefined && usage.contextWindow > 0) {
    sendThreadDeltas(threadId, [{ kind: "contextWindow", used: usage.tokens,
      size: usage.contextWindow, estimated: true, attach: "currentOrLast" }]);
  }
}

function reportPromptSettled(threadId: string, entry: ThreadSession, error?: unknown): void {
  if (!isCurrentSession(threadId, entry)) return;
  sendThreadDeltas(threadId, [{ kind: "turn.boundary", status: error === undefined ? "completed" : "failed",
    ...(error === undefined ? {} : { error: { message: safeError(error) } }), claimIfIdle: true }]);
}

async function handleRequest(
  request: PiCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize": {
      const result: InitializeResult = {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "inject",
          skills: { configure: true },
        },
      };
      sendResult(request.id, result);
      break;
    }
    case "model/list":
      await handleModelList(request.id, request.params);
      break;
    case "provider/health":
      await handleProviderHealth(request.id, request.params);
      break;
    case "provider/usage":
      sendResult(request.id, { supported: false });
      break;
    case "provider/installation/status":
      await requireRuntime();
      sendResult(request.id, { supported: false });
      break;
    case "provider/installation/run":
      sendResult(request.id, { supported: false });
      break;
    case "thread/start":
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        request.params.threadId,
        toPiSessionParams(request.params),
      );
      break;
    case "thread/resume": {
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        request.params.providerThreadId,
        toPiSessionParams(request.params),
        true,
      );
      break;
    }
    case "thread/fork":
      await handleThreadFork(request.id, request.params);
      break;
    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      await handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      await handleThreadStop(request.id, request.params);
      break;
    case "thread/discard":
      sendResult(request.id, await handleThreadDiscard(request.params));
      break;
    case "skills/configure":
      configuredSkillPaths = request.params.roots.map((root) => root.path);
      sendResult(request.id, { ok: true });
      break;
  }
}

type ThreadForkParams = z.infer<typeof threadForkParamsSchema>;
type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParams = z.infer<typeof turnSteerParamsSchema>;
type ThreadStopParams = z.infer<typeof threadStopParamsSchema>;
type ThreadRefParams = z.infer<typeof threadDiscardParamsSchema>;

function toPiSessionParams(
  params: z.infer<typeof threadStartParamsSchema>,
): PiSessionParams {
  return buildPiSessionParams({
    threadId: params.threadId,
    cwd: params.cwd,
    options: params.options,
    instructionMode: params.instructionMode,
    dynamicTools: params.dynamicTools,
    disallowedTools: params.disallowedTools,
    additionalSkillPaths: configuredSkillPaths ?? undefined,
  });
}

const setupModel = {
  id: "vrata-setup", model: "vrata-setup", displayName: "Настроить Врата AI",
  description: "Добавьте ключ и выберите модель", isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "none" as const, description: "Без рассуждений" }],
  defaultReasoningEffort: "none" as const,
};
async function handleModelList(id: string | number, _params: { cwd?: string }): Promise<void> {
  const config = readConfig(requireDataDir());
  if (!config) {
    sendResult(id, { models: [setupModel], selectedOnlyModels: [] });
    return;
  }
  try {
    const catalog = await fetchModels(config);
    sendResult(id, buildPiAvailableModels(buildPiModels(catalog, config.baseUrl)));
  } catch {
    sendError(id, -32000, "Не удалось получить каталог моделей Врата AI");
  }
}
async function handleProviderHealth(id: string | number, _params: { cwd?: string }): Promise<void> {
  await requireRuntime();
  const config = readConfig(requireDataDir());
  let status: "ready" | "unauthenticated" | "unknown" = "unauthenticated";
  let statusMessage: string | null = "Добавьте ключ Врата AI на этой машине";
  if (config) {
    try {
      const models = await fetchModels(config);
      status = models.length ? "ready" : "unknown";
      statusMessage = models.length ? null : "Нет доступных моделей Врата AI";
    } catch {
      status = "unknown";
      statusMessage = "Не удалось проверить ключ и каталог Врата AI";
    }
  }
  sendResult(id, { supported: true, health: {
    status, statusMessage, accountEmail: null, planLabel: null, installedVersion: "Pi 1.3.0 (embedded)",
    minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null,
  } });
}

function resolvePiModel(model: string, models: Model<Api>[]): { provider: string; id: string } {
  const id = model.replace(/^(?:vrata|vrata\.tg)\//, "");
  if (!models.some((candidate) => candidate.id === id)) throw new SetupError("Выбранная модель недоступна");
  return { provider: VRATA_PROVIDER_ID, id };
}

function buildSessionOptions(args: {
  params: PiSessionParams;
  providerThreadId: string;
  threadId: string;
  models: Model<Api>[];
}): PiRpcSessionOptions {
  return {
    runtime: childRuntime(args.models),
    cwd: args.params.cwd,
    ...(args.params.model
      ? { model: resolvePiModel(args.params.model, args.models) }
      : {}),
    sessionFilePath: sessionPath(args.providerThreadId),
    sessionDir: runtime!.sessionDir,
    systemPrompt: args.params.baseInstructions,
    appendSystemPrompt: args.params.appendSystemPrompt,
    shellEnvOverrides: args.params.shellEnvOverrides,
    disallowedTools: args.params.disallowedTools,
    ...(args.params.additionalSkillPaths
      ? { additionalSkillPaths: [...args.params.additionalSkillPaths] }
      : {}),
    ...(args.params.thinkingLevel
      ? { thinkingLevel: args.params.thinkingLevel }
      : {}),
    ...(args.params.dynamicTools && args.params.dynamicTools.length > 0
      ? { dynamicTools: args.params.dynamicTools }
      : {}),
    scratchDir: requireScratchDir(),
    extensionPath: requireExtensionPath(),
    recordThreadId: args.threadId,
  };
}

async function startPiThreadSession(
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
  models: Model<Api>[],
  controller: AbortController,
): Promise<void> {
  checkCurrent(threadId, controller);
  await closeThreadSession({ message: "Pi session replaced", threadId });
  checkCurrent(threadId, controller);
  const entry: ThreadSession = {
    providerThreadId,
    models,
    cwd: persistedSessionCwd(providerThreadId) ?? params.cwd,
    translator: createPiDeltaTranslator(),
    admission: Promise.resolve(),
    session: new PiRpcSession(
      buildSessionOptions({ params, providerThreadId, threadId, models }),
      (toolName, args) => isCurrentSession(threadId, entry)
        ? forwardToolCall({ arguments: args, providerThreadId, scope: entry, threadId, toolName })
        : Promise.resolve({ content: "Thread session not found", isError: true }),
      (event) => {
        if (!isCurrentSession(threadId, entry)) return;
        sendThreadDeltas(threadId, entry.translator.translate(event, {
          cwd: entry.cwd, modelContextWindow: entry.session.getLiveModel()?.contextWindow,
        }));
        if (event.type === "turn_end" || event.type === "compaction_end") emitContextWindowUsage(threadId, entry);
      },
      (error, interruptedRun) => {
        reportSessionError(threadId, entry, error);
        if (interruptedRun) reportPromptSettled(threadId, entry, error);
      },
    ),
  };
  sessions.set(threadId, entry);
  try {
    await entry.session.start();
    checkCurrent(threadId, controller);
  } catch (error) {
    if (sessions.get(threadId) === entry) await closeThreadSession({ message: "Pi startup failed", threadId });
    throw error;
  }
}

function sendThreadSessionResult(
  id: string | number,
  threadId: string,
  providerThreadId: string,
): void {
  sendThreadIdentity(threadId, providerThreadId);
  sendThreadDeltas(threadId, [{ kind: "session.reset" }]);
  sendResult(id, { providerThreadId, sessionRestorable: true });
}

async function handleThreadConstruction(
  id: string | number,
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
  resume = false,
): Promise<void> {
  const wasPending = cancelPending(threadId);
  if (wasPending) sendThreadDeltas(threadId, [{ kind: "session.ended" }]);
  const controller = new AbortController();
  generations.set(threadId, controller);
  await closeThreadSession({ message: "Pi session replaced", threadId });
  checkCurrent(threadId, controller);
  const prepared = await requireRuntime();
  checkCurrent(threadId, controller);
  if (resume) {
    await ensureLegacySession({ dataDir: requireDataDir(), cwd: params.cwd, providerThreadId,
      sessionDir: prepared.sessionDir, sdkEntry: prepared.sdkEntry });
    checkCurrent(threadId, controller);
    if (resumedSessionMissingCwd(providerThreadId)) throw new SetupError("Рабочая папка сохранённой сессии больше не существует");
  }
  const requestedModel = normalizeModel(params.model);
  const normalized = { ...params, model: requestedModel,
    ...(params.model === "vrata-setup" ? { thinkingLevel: undefined } : {}),
  };
  const config = readConfig(requireDataDir());
  if (!config || (!requestedModel && !existsSync(sessionPath(providerThreadId)))) {
    pendingConstruction.set(threadId, { providerThreadId, params: normalized, controller });
    sendThreadSessionResult(id, threadId, providerThreadId);
    return;
  }
  const catalog = await fetchModels(config, controller.signal);
  checkCurrent(threadId, controller);
  const models = buildPiModels(catalog, config.baseUrl);
  if (requestedModel) resolvePiModel(requestedModel, models);
  await startPiThreadSession(threadId, providerThreadId, normalized, models, controller);
  checkCurrent(threadId, controller);
  sendThreadSessionResult(id, threadId, providerThreadId);
}

function resumedSessionMissingCwd(providerThreadId: string): string | null {
  const cwd = persistedSessionCwd(providerThreadId);
  return cwd !== null && !existsSync(cwd) ? cwd : null;
}

function persistedSessionCwd(providerThreadId: string): string | null {
  const sessionFile = sessionPath(providerThreadId);
  let firstLine: string;
  try {
    firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return null;
  }
  try {
    const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string"
      ? header.cwd
      : null;
  } catch {
    return null;
  }
}

async function handleThreadFork(
  id: string | number,
  params: ThreadForkParams,
): Promise<void> {
  cancelPending(params.threadId);
  const controller = new AbortController();
  generations.set(params.threadId, controller);
  await closeThreadSession({ message: "Pi session replaced by fork", threadId: params.threadId });
  checkCurrent(params.threadId, controller);
  const prepared = await requireRuntime();
  checkCurrent(params.threadId, controller);
  await ensureLegacySession({ dataDir: requireDataDir(), cwd: params.cwd, providerThreadId: params.sourceProviderThreadId,
    sessionDir: prepared.sessionDir, sdkEntry: prepared.sdkEntry });
  checkCurrent(params.threadId, controller);
  const sourceSessionFile = sessionPath(params.sourceProviderThreadId);
  if (!existsSync(sourceSessionFile)) {
    sendError(
      id,
      -32000,
      `Cannot fork: source pi session file not found for thread "${params.sourceProviderThreadId}"`,
    );
    return;
  }
  const targetSessionFile = sessionPath(params.threadId);
  let temporaryFork: string | undefined;
  try {
    const { SessionManager } = await import(pathToFileURL(prepared.sdkEntry).href) as typeof import("@earendil-works/pi-coding-agent");
    checkCurrent(params.threadId, controller);
    temporaryFork = params.sourceProviderCheckpointId === undefined
      ? SessionManager.forkFrom(sourceSessionFile, params.cwd, prepared.sessionDir).getSessionFile()
      : SessionManager.open(sourceSessionFile, prepared.sessionDir, params.cwd).createBranchedSession(params.sourceProviderCheckpointId) ?? undefined;
    if (!temporaryFork) throw new Error("Forked Pi session was not persisted");
    checkCurrent(params.threadId, controller);
    renameSync(temporaryFork, targetSessionFile);
  } finally {
    if (temporaryFork) rmSync(temporaryFork, { force: true });
  }
  checkCurrent(params.threadId, controller);
  await handleThreadConstruction(
    id,
    params.threadId,
    params.threadId,
    toPiSessionParams(params),
  );
}

function startPiCompaction(entry: ThreadSession, threadId: string): void {
  // Native compaction_end owns completion. Only failures before that event
  // need a bridge terminal (compact() distinguishes those failures).
  void entry.session.compact().catch((error: unknown) => reportPromptSettled(threadId, entry, error));
}

function recordAcceptedTurnInput(params: TurnStartParams): void {
  sendThreadDeltas(params.threadId, [
    { kind: "input.accepted", clientRequestId: params.clientRequestId },
  ]);
}

async function dispatchTurn(params: TurnStartParams): Promise<void> {
  const { threadId } = params;
  const controller = generations.get(threadId);
  const entry = sessions.get(threadId);
  if (!controller || !entry || entry.closeTask) throw new SetupError("Нет активной сессии Pi");
  const admission = entry.admission.then(async () => {
    checkCurrent(threadId, controller);
    const options = buildPiTurnOptions(params.options.model === "vrata-setup" ? {} : params.options);
    await entry.session.applyOptions({
      model: options.model ? resolvePiModel(options.model, entry.models) : undefined,
      thinkingLevel: options.thinkingLevel,
    });
    checkCurrent(threadId, controller);
    if (isStandaloneBuiltinCompactCommand(params.input)) {
      startPiCompaction(entry, threadId);
      return;
    }
    const { text, images } = extractInput(params.input);
    if (!text && images.length === 0) throw new SetupError("Отсутствует текст запроса");
    const dispatch = entry.session.prompt(text ?? "", images);
    const disposition = await dispatch.admitted;
    checkCurrent(threadId, controller);
    if (disposition === "handled") reportPromptSettled(threadId, entry);
    return dispatch;
  });
  // Serialize settings and admission, never the full turn or queued consumption.
  entry.admission = admission.then(() => undefined, () => undefined);
  const dispatch = await admission;
  await dispatch?.consumed;
  checkCurrent(threadId, controller);
}

async function completeSetup(params: TurnStartParams, pending: PendingConstruction): Promise<void> {
  const { threadId } = params;
  try {
    checkCurrent(threadId, pending.controller);
    if (!readConfig(requireDataDir())) {
      const answer = await requestInteraction(threadId, pending, { kind: "vrata/api-key", title: "Ключ API Врата AI", data: {} });
      checkCurrent(threadId, pending.controller);
      if (!z.object({ kind: z.literal("request_answer"), value: z.object({ configured: z.literal(true) }) }).safeParse(answer).success) {
        throw new SetupError("Ключ Врата AI не сохранён. Повторите настройку.");
      }
    }
    let config = readConfig(requireDataDir());
    if (!config) throw new SetupError("Добавьте ключ Врата AI для машины треда в настройках плагина");
    let models = buildPiModels(await fetchModels(config, pending.controller.signal), config.baseUrl);
    checkCurrent(threadId, pending.controller);
    let model = normalizeModel(params.options.model) ?? pending.params.model;
    let thinking = params.options.model === "vrata-setup" ? pending.params.thinkingLevel
      : buildPiTurnOptions(params.options).thinkingLevel ?? pending.params.thinkingLevel;
    if (!model && !existsSync(sessionPath(pending.providerThreadId))) {
      const answer = await requestInteraction(threadId, pending, { kind: "vrata/model", title: "Выберите модель Врата AI", data: {
        models: models.map((entry) => ({ id: entry.id, name: entry.name, reasoningLevels: supportedReasoningLevels(entry) })),
      } });
      checkCurrent(threadId, pending.controller);
      const selected = z.object({ kind: z.literal("request_answer"), value: z.object({ modelId: z.string(), reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max"]) }) }).safeParse(answer);
      if (!selected.success) throw new SetupError("Выберите модель и доступный уровень рассуждений");
      model = normalizeModel(selected.data.value.modelId);
      thinking = selected.data.value.reasoningLevel === "none" ? "off" : selected.data.value.reasoningLevel;
    }
    // A local credential change during either form must affect the configuration used to launch Pi.
    const latestConfig = readConfig(requireDataDir());
    if (!latestConfig) throw new SetupError("Ключ Врата AI удалён. Повторите настройку.");
    if (latestConfig.apiKey !== config.apiKey || latestConfig.baseUrl !== config.baseUrl) {
      config = latestConfig;
      models = buildPiModels(await fetchModels(config, pending.controller.signal), config.baseUrl);
      checkCurrent(threadId, pending.controller);
    }
    if (model) {
      const candidate = models.find((entry) => `${entry.provider}/${entry.id}` === model);
      if (!candidate) throw new SetupError("Выбранная модель недоступна");
      const levels = supportedReasoningLevels(candidate);
      const requested = thinking === "off" ? "none" : thinking;
      if (requested && !levels.includes(requested)) throw new SetupError("Модель не поддерживает выбранный уровень рассуждений");
    }
    checkCurrent(threadId, pending.controller);
    await startPiThreadSession(threadId, pending.providerThreadId, { ...pending.params, model, thinkingLevel: thinking }, models, pending.controller);
    checkCurrent(threadId, pending.controller);
    // Setup already applied and validated the selected options to this child.
    await dispatchTurn({ ...params, options: { ...params.options, model: "vrata-setup" } });
  } catch (error) {
    if (!pending.controller.signal.aborted && generations.get(threadId) === pending.controller) {
      const message = safeError(error);
      sendSessionScopedError(threadId, pending.providerThreadId, message);
      sendThreadDeltas(threadId, [{ kind: "turn.boundary", status: "failed", error: { message } }]);
    }
  } finally {
    if (pendingConstruction.get(threadId) === pending && sessions.has(threadId)) pendingConstruction.delete(threadId);
    pending.task = undefined;
  }
}

async function handleTurnStart(id: string | number, params: TurnStartParams): Promise<void> {
  const pending = pendingConstruction.get(params.threadId);
  if (pending) {
    if (pending.task) { sendError(id, -32000, "Pi уже ожидает настройку"); return; }
    checkCurrent(params.threadId, pending.controller);
    // Reserve synchronously before yielding; acknowledge both RPCs before any human wait.
    recordAcceptedTurnInput(params);
    sendThreadDeltas(params.threadId, [{ kind: "turn.open" }]);
    sendResult(id, { threadId: params.threadId });
    pending.task = Promise.resolve().then(() => completeSetup(params, pending));
    return;
  }
  try {
    await dispatchTurn(params);
    recordAcceptedTurnInput(params);
    sendResult(id, { threadId: params.threadId });
  } catch (error) { sendError(id, -32000, safeError(error)); }
}

async function handleTurnSteer(id: string | number, params: TurnSteerParams): Promise<void> {
  const { threadId } = params;
  const entry = sessions.get(threadId);
  const controller = generations.get(threadId);
  if (!entry || entry.closeTask || !controller) {
    sendError(id, -32000, "No active pi session");
    return;
  }
  const { text, images } = extractInput(params.input);
  if (!text && images.length === 0) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  const admission = entry.admission.then(async () => {
    checkCurrent(threadId, controller);
    if (entry.session.getIsCompacting()) throw new Error("Cannot steer while context compaction is active");
    const dispatch = entry.session.prompt(text ?? "", images, true);
    const disposition = await dispatch.admitted;
    checkCurrent(threadId, controller);
    if (disposition === "handled") reportPromptSettled(threadId, entry);
    return dispatch;
  });
  entry.admission = admission.then(() => undefined, () => undefined);
  try {
    const dispatch = await admission;
    sendResult(id, { threadId });
    void dispatch.consumed.then(() => {
      if (isCurrentSession(threadId, entry)) {
        sendThreadDeltas(threadId, [{ kind: "input.accepted", clientRequestId: params.clientRequestId }]);
      }
    }, (error: unknown) => reportSessionError(threadId, entry, error));
  } catch (error) {
    sendError(id, -32000, safeError(error));
  }
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): Promise<void> {
  const hadPendingTurn = cancelPending(params.threadId);
  const threadSession = sessions.get(params.threadId);
  if (
    params.intent === "interrupt" &&
    (hadPendingTurn || (threadSession !== undefined && !threadSession.closeTask))
  ) {
    sendThreadDeltas(params.threadId, [{ kind: "session.ended" }]);
  }
  const providerCheckpointId =
    (await closeThreadSession({
      message: "Pi thread stopped while tool call was pending",
      threadId: params.threadId,
    })) ?? null;
  sendResult(id, { ok: true, providerCheckpointId });
}

async function handleThreadDiscard(
  params: ThreadRefParams,
): Promise<{ ok: true }> {
  cancelPending(params.threadId);
  await requireRuntime();
  await closeThreadSession({
    message: "Pi staged thread discarded while tool call was pending",
    threadId: params.threadId,
  });
  rmSync(
    sessionPath(params.providerThreadId),
    {
      force: true,
    },
  );
  return { ok: true };
}

interface ExtractedInput {
  text?: string;
  images: ImageContent[];
}

function extractInput(input: TurnStartParams["input"]): ExtractedInput {
  const chunks: string[] = [];
  const images: ImageContent[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const typed = item as {
      type?: string;
      text?: string;
      path?: string;
      mimeType?: string;
    };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    } else if (typed.type === "localImage" && typeof typed.path === "string") {
      try {
        const data = readFileSync(typed.path).toString("base64");
        const mimeType = typed.mimeType ?? mimeTypeFromExtension(typed.path);
        images.push({ type: "image", data, mimeType });
      } catch {}
    } else if (typed.type === "localFile" && typeof typed.path === "string") {
      chunks.push(`[Attached file: ${typed.path}]`);
    }
  }
  return { text: chunks.length > 0 ? chunks.join("\n") : undefined, images };
}

function handleParsedMessage(parsed: unknown): void {
  if (bridgeClosed) return;
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response) {
    const pending = pendingInteractions.get(String(response.id));
    if (pending) {
      pendingInteractions.delete(String(response.id));
      if ("error" in response) pending.reject(new SetupError("Настройка отменена"));
      else pending.resolve(response.result);
      return;
    }
  }
  if (response && handleToolCallResponse(response)) {
    return;
  }
  const decoded = decodePiJsonRpcRequest(parsed);
  if (decoded.kind === "ignored") {
    return;
  }
  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`,
    );
    return;
  }
  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`,
    );
    return;
  }
  runBridgeRequest({ request: decoded.request, handleRequest: async (request) => {
    try { await handleRequest(request); }
    catch (error) { sendError(request.id, -32000, safeError(error)); }
  }, sendError });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

async function shutdown(): Promise<void> {
  bridgeClosed = true;
  for (const threadId of generations.keys()) cancelPending(threadId);
  await closeThreadSessionsGracefully("Pi bridge shutting down");
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: (context) => {
    dataDir = context.dataDir;
    redactor = createCredentialRedactor(join(dataDir, "credentials.json"));
    bridgeClosed = false;
    runtime = undefined;
    runtimePromise = undefined;
    extensionPath = null;
    configuredSkillPaths = null;
    scratchDir = join(context.tempDir, "pi");
    mkdirSync(scratchDir, { recursive: true });
  },
  onClose: () => { void shutdown(); },
  onSigterm: () => { void shutdown(); },
});
