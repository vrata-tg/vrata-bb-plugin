import { z } from "zod";
import {
  ZERO_TOKEN_USAGE, addTokenUsage, bashArgsSchema, extractResultText,
  isRecord, normalizeProviderCommandOutput, providerRawEventSchema,
  textBlockSchema, toNonNegativeNumber, toOptionalString, toPositiveNumber,
  type DeltaItemShape, type DeltaNoTurnFallback, type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";

const contentBlock = z.object({ type: z.string() }).passthrough();
const message = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(contentBlock)]).optional(),
  display: z.boolean().optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  usage: z.object({
    input: z.number().optional(), output: z.number().optional(),
    cacheRead: z.number().optional(), cacheWrite: z.number().optional(),
    totalTokens: z.number().optional(),
  }).optional(),
});
const endFields = {
  messages: z.array(message),
  providerCheckpointId: z.string().min(1).optional(),
  willRetry: z.boolean().default(false),
};
const compactionReason = z.enum(["manual", "threshold", "overflow"]);
const toolFields = { toolCallId: z.string(), toolName: z.string() };

// Pi is a separate process: validate its output once before producing SDK deltas.
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({ type: z.literal("agent_end"), ...endFields }),
  z.object({ type: z.literal("agent_settled"), ...endFields, aborted: z.boolean().optional() }),
  z.object({ type: z.literal("compaction_start"), reason: compactionReason }),
  z.object({
    type: z.literal("compaction_end"), reason: compactionReason,
    aborted: z.boolean(), errorMessage: z.string().optional(),
  }),
  z.object({ type: z.enum(["message_start", "message_end"]), message }),
  z.object({
    type: z.literal("message_update"),
    assistantMessageEvent: z.object({
      type: z.string(), content: z.string().optional(),
      contentIndex: z.number().optional(), delta: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("tool_execution_start"), ...toolFields, args: z.unknown() }),
  z.object({ type: z.literal("tool_execution_end"), ...toolFields, result: z.unknown(), isError: z.boolean() }),
  z.object({ type: z.literal("tool_execution_update"), ...toolFields, partialResult: z.unknown() }),
]);
const fileArgsSchema = z.object({
  path: z.string().optional(), oldText: z.string().optional(),
  newText: z.string().optional(), content: z.string().optional(),
});
const ignoredEvents = new Set(["auto_retry_start", "auto_retry_end", "turn_start", "turn_end"]);
const ignoredUpdates = new Set([
  "text_start", "text_end", "thinking_start", "toolcall_start", "toolcall_delta", "toolcall_end",
]);
const compactionNoops = new Set([
  "Compaction failed: Nothing to compact (session too small)",
  "Compaction failed: Already compacted",
]);
const assistantKey = { channel: "assistant" };

type PiMessage = z.infer<typeof message>;
interface EventContext { cwd?: string; modelContextWindow?: number | null }

function fallback(event: unknown): DeltaNoTurnFallback {
  const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
  const raw = providerRawEventSchema.safeParse({
    jsonrpc: "2.0", method: "sdk/message", params: { message: event },
  });
  return {
    raw: raw.success ? raw.data : {
      jsonrpc: "2.0", method: "sdk/message",
      params: { serializationError: "Provider event was not JSON-serializable." },
    },
    rawType: `sdk/${type}`,
  };
}

function unhandled(event: unknown): ThreadDelta[] {
  return [{ kind: "unhandled", ...fallback(event), vouchedTurn: true }];
}

function messageText(content: PiMessage["content"]): string | undefined {
  const text = (typeof content === "string" ? content : (content ?? []).flatMap((block) => {
    const parsed = textBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data.text] : [];
  }).join("\n")).trim();
  return text || undefined;
}

function assistantError(message: PiMessage | undefined): string | undefined {
  return message?.stopReason === "error" && message.errorMessage?.trim()
    ? message.errorMessage : undefined;
}

function lastAssistant(messages: PiMessage[]): PiMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

function commandOutput(text: string): string | undefined {
  return normalizeProviderCommandOutput({ text, emptyPlaceholders: ["(no output)"] });
}

function toolShape(name: string, args: unknown, cwd?: string): DeltaItemShape {
  if (name === "bash") {
    const parsed = bashArgsSchema.safeParse(args);
    const command = parsed.success ? toOptionalString(parsed.data.command) : undefined;
    const directory = (parsed.success ? toOptionalString(parsed.data.cwd) : undefined) ?? toOptionalString(cwd);
    if (command && directory) return { type: "command", command, cwd: directory };
  }
  if (name === "edit" || name === "write") {
    const parsed = fileArgsSchema.safeParse(args);
    if (parsed.success && parsed.data.path) {
      const { path, oldText, newText, content } = parsed.data;
      return { type: "fileChange", changes: [{
        path, kind: oldText === undefined ? "add" : "update",
        ...(oldText === undefined ? {} : { oldText }),
        ...((newText ?? content) === undefined ? {} : { newText: newText ?? content }),
      }] };
    }
  }
  return { type: "tool", tool: name, args };
}

/** Owned by one live Pi session; disposal releases all usage and tool state. */
export function createPiDeltaTranslator() {
  const tools = new Map<string, DeltaItemShape>();
  let total = { ...ZERO_TOKEN_USAGE };

  function translate(event: unknown, context: EventContext = {}): ThreadDelta[] {
    if (isRecord(event) && typeof event.type === "string" && ignoredEvents.has(event.type)) return [];
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) return unhandled(event);
    const e = parsed.data;
    switch (e.type) {
      case "agent_start":
        return [{ kind: "turn.open" }];

      case "message_start":
      case "message_end": {
        if (!["assistant", "custom", "toolResult", "user"].includes(e.message.role)) return unhandled(event);
        if (e.type !== "message_start" || e.message.role !== "custom" || !e.message.display) return [];
        const text = messageText(e.message.content);
        return text ? [{ kind: "input.provider", text }] : [];
      }

      case "message_update": {
        const update = e.assistantMessageEvent;
        if (ignoredUpdates.has(update.type)) return [];
        if (update.type === "text_delta") {
          return update.delta ? [{ kind: "item.textDelta", key: assistantKey, channel: "agentMessage", text: update.delta }] : [];
        }
        if (update.type === "thinking_delta" || update.type === "thinking_end") {
          const text = update.type === "thinking_delta" ? update.delta : update.content;
          if (!text) return [];
          if (update.contentIndex === undefined) return unhandled(event);
          return [{
            kind: update.type === "thinking_delta" ? "item.textDelta" : "item.textClose",
            key: { channel: `thinking-${update.contentIndex}` }, channel: "reasoningText", text,
          }];
        }
        return unhandled(event);
      }

      case "agent_end": {
        const last = lastAssistant(e.messages);
        const error = assistantError(last);
        if (e.willRetry) {
          return error ? [{ kind: "provider.error", message: "Provider error", detail: error, willRetry: true }] : [];
        }
        tools.clear();
        if (error) return [{ kind: "provider.error", message: "Provider error", detail: error }];
        const deltas: ThreadDelta[] = [];
        const text = messageText(last?.content);
        if (text) deltas.push({ kind: "item.textClose", key: assistantKey, channel: "agentMessage", text });
        if (last?.usage) {
          const inputTokens = toNonNegativeNumber(last.usage.input);
          const outputTokens = toNonNegativeNumber(last.usage.output);
          const cachedInputTokens = toNonNegativeNumber(last.usage.cacheRead) + toNonNegativeNumber(last.usage.cacheWrite);
          const usage = {
            totalTokens: toPositiveNumber(last.usage.totalTokens) ?? inputTokens + outputTokens + cachedInputTokens,
            inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens: 0,
          };
          total = addTokenUsage(total, usage);
          deltas.push({ kind: "usage", total, last: usage, modelContextWindow: toPositiveNumber(context.modelContextWindow) ?? null });
        }
        return deltas;
      }

      case "agent_settled": {
        tools.clear();
        const error = assistantError(lastAssistant(e.messages));
        return [{
          kind: "turn.boundary", status: e.aborted ? "interrupted" : error ? "failed" : "completed",
          ...(error ? { error: { message: error } } : {}),
          ...(e.providerCheckpointId ? { providerCheckpointId: e.providerCheckpointId } : {}),
          claimIfIdle: true,
        }];
      }

      case "compaction_start": {
        const open: ThreadDelta = {
          kind: "item.open", key: { channel: "compaction" }, item: { type: "compaction" },
          ...(e.reason === "manual" ? {} : { attach: "currentOrLast" }),
          noTurnFallback: fallback(event),
        };
        return e.reason === "manual" ? [{ kind: "turn.open" }, open] : [open];
      }

      case "compaction_end": {
        const succeeded = !e.aborted && !e.errorMessage;
        const compacted: ThreadDelta = { kind: "context.compacted", noTurnFallback: fallback(event) };
        if (e.reason !== "manual") {
          return succeeded ? [compacted] : [{
            kind: "provider.error",
            message: e.aborted ? "Context compaction interrupted" : "Context compaction failed",
            detail: e.errorMessage ?? "Automatic context compaction was interrupted",
          }];
        }
        tools.clear();
        if (!e.aborted && e.errorMessage && compactionNoops.has(e.errorMessage.trim())) {
          return [{
            kind: "provider.warning", category: "compaction-skipped", summary: "Context compaction skipped",
            details: e.errorMessage, vouchedTurn: true,
          }, { kind: "turn.boundary", status: "completed" }];
        }
        return [
          ...(succeeded ? [compacted] : []),
          { kind: "turn.boundary", status: e.aborted ? "interrupted" : e.errorMessage ? "failed" : "completed",
            ...(e.errorMessage ? { error: { message: e.errorMessage } } : {}) },
        ];
      }

      case "tool_execution_start": {
        const item = toolShape(e.toolName, e.args, context.cwd);
        tools.set(e.toolCallId, item);
        return [{ kind: "item.open", key: { providerItemId: e.toolCallId }, item, noTurnFallback: fallback(event) }];
      }

      case "tool_execution_end": {
        const item = tools.get(e.toolCallId) ?? (e.toolName === "edit" || e.toolName === "write"
          ? { type: "fileChange" as const, changes: [] } : { type: "tool" as const, tool: e.toolName });
        tools.delete(e.toolCallId);
        const resultText = extractResultText(e.result);
        const aggregatedOutput = e.toolName === "bash" ? commandOutput(resultText) : undefined;
        return [{
          kind: "item.close", key: { providerItemId: e.toolCallId },
          status: e.isError ? "failed" : "completed", resultText,
          exitCode: e.isError ? 1 : 0, item,
          ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
          noTurnFallback: fallback(event),
        }];
      }

      case "tool_execution_update": {
        const key = { providerItemId: e.toolCallId }, noTurnFallback = fallback(event);
        if (e.toolName === "bash") {
          const text = commandOutput(extractResultText(e.partialResult));
          return text === undefined ? [] : [{ kind: "command.outputSnapshot", key, text, noTurnFallback }];
        }
        return [{
          kind: "item.progress", key, noTurnFallback,
          message: extractResultText(e.partialResult).trim() || `${e.toolName} progress update`,
        }];
      }
    }
  }
  return { translate };
}
