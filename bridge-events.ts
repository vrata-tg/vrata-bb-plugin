import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { DeltaPresentation, ThreadDelta, ThreadEventTokenUsageBreakdown } from "@get-bb/plugin-sdk/provider-bridge";

export const CONTEXT_LIMIT_MESSAGE = "Контекст модели заполнен. Начните новый тред или выберите модель с большим контекстом. История сохранена.";

// Never surface an upstream body: it can contain request headers, URLs or credentials.
export function providerErrorMessage(message: string | undefined, status?: number): string {
  if (message === CONTEXT_LIMIT_MESSAGE || /context.{0,30}(length|window|limit)|too many tokens|prompt is too long/i.test(message ?? "")) return CONTEXT_LIMIT_MESSAGE;
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(message ?? "")) return "Ключ Врата AI недействителен или не имеет доступа к модели.";
  if (status === 429 || /\b429\b/.test(message ?? "")) return "Врата AI ограничили частоту запросов. Повторите запрос позже.";
  if (status === 402 || /\b402\b/.test(message ?? "")) return "Недостаточно средств для запроса Врата AI. Проверьте баланс.";
  if (status && status >= 300 && status < 400) return "API вернул перенаправление. Проверьте адрес API; запрос не перенаправлялся.";
  if (status && status >= 400) return `Запрос Врата AI завершился ошибкой HTTP ${status}.`;
  return "Не удалось получить ответ Врата AI. Проверьте подключение, настройки API и доступность модели.";
}

export function tokenUsage(usage: Usage): ThreadEventTokenUsageBreakdown {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    cachedInputTokens: usage.cacheRead,
    outputTokens: usage.output,
    reasoningOutputTokens: usage.reasoning ?? 0,
    totalTokens: usage.totalTokens,
  };
}

export function emitError(emit: (...deltas: ThreadDelta[]) => void, text: string): void {
  const key = { providerItemId: `error-${randomUUID()}` };
  emit(
    { kind: "item.open", key, item: { type: "agentMessage", text: "" } },
    { kind: "item.textClose", key, channel: "agentMessage", text },
  );
}

/** One Pi run's open items; cancellation closes exactly those items already emitted. */
export function createTurnOutput(options: {
  emit: (...deltas: ThreadDelta[]) => void;
  onUsage: (usage: Usage) => void;
  onError: () => void;
  httpStatus: () => number | undefined;
  presentation: (tool: string) => DeltaPresentation | undefined;
}) {
  const { emit } = options;
  let assistant: AssistantMessage | undefined;
  let messageKey: string | undefined;
  const reasoningKeys = new Map<number, string>();
  const tools = new Map<string, { name: string; args: unknown }>();
  let ended = false;

  function closeMessage(): void {
    if (messageKey) {
      const text = assistant?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
      emit({ kind: "item.textClose", key: { providerItemId: messageKey }, channel: "agentMessage", text });
      messageKey = undefined;
    }
    for (const [index, key] of reasoningKeys) {
      const part = assistant?.content[index];
      emit({ kind: "item.textClose", key: { providerItemId: key }, channel: "reasoningText", text: part?.type === "thinking" ? part.thinking : "" });
    }
    reasoningKeys.clear();
    assistant = undefined;
  }

  function close(status: "completed" | "failed" | "interrupted"): void {
    if (ended) return;
    closeMessage();
    for (const [id, tool] of tools) {
      emit({ kind: "item.close", key: { providerItemId: id }, status, item: { type: "tool", tool: tool.name, args: tool.args } });
    }
    tools.clear();
    ended = true;
  }

  function onEvent(event: AgentEvent): void {
    if (ended) return;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          assistant = event.message;
          messageKey = `message-${randomUUID()}`;
          emit({ kind: "item.open", key: { providerItemId: messageKey }, item: { type: "agentMessage", text: "" } });
        }
        break;
      case "message_update": {
        if (event.message.role === "assistant") assistant = event.message;
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" && messageKey) {
          emit({ kind: "item.textDelta", key: { providerItemId: messageKey }, channel: "agentMessage", text: update.delta });
        } else if (update.type === "thinking_start") {
          const key = `reasoning-${randomUUID()}`;
          reasoningKeys.set(update.contentIndex, key);
          emit({ kind: "item.open", key: { providerItemId: key }, item: { type: "reasoning", content: [], summary: [] } });
        } else if (update.type === "thinking_delta") {
          const key = reasoningKeys.get(update.contentIndex);
          if (key) emit({ kind: "item.textDelta", key: { providerItemId: key }, channel: "reasoningText", text: update.delta });
        }
        break;
      }
      case "message_end":
        if (event.message.role === "assistant") {
          assistant = event.message;
          if (event.message.errorMessage) event.message.errorMessage = providerErrorMessage(event.message.errorMessage, options.httpStatus());
          closeMessage();
          options.onUsage(event.message.usage);
          if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            options.onError();
            emitError(emit, event.message.errorMessage ?? providerErrorMessage(undefined, options.httpStatus()));
          }
        }
        break;
      case "tool_execution_start":
        tools.set(event.toolCallId, { name: event.toolName, args: event.args });
        emit({ kind: "item.open", key: { providerItemId: event.toolCallId }, item: { type: "tool", tool: event.toolName, args: event.args }, presentation: options.presentation(event.toolName) });
        break;
      case "tool_execution_update": {
        const content = event.partialResult?.content;
        if (Array.isArray(content)) {
          const message = content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
          emit({ kind: "item.progress", key: { providerItemId: event.toolCallId }, message });
        }
        break;
      }
      case "tool_execution_end": {
        const tool = tools.get(event.toolCallId);
        tools.delete(event.toolCallId);
        emit({ kind: "item.close", key: { providerItemId: event.toolCallId }, status: event.isError ? "failed" : "completed", item: { type: "tool", tool: event.toolName, args: tool?.args ?? {}, result: event.result } });
        break;
      }
    }
  }
  return { onEvent, close };
}
