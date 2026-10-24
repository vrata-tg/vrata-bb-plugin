import { VRATA_PROVIDER_ID } from "./vrata.js";

export const VRATA_PI_SETTINGS = {
  httpIdleTimeoutMs: 3_900_000,
  retry: {
    enabled: true,
    maxRetries: 20,
    provider: { timeoutMs: 3_900_000, maxRetries: 0 },
  },
} as const;

// Embedded in host.js, then written by pi-runtime to an explicit extension path.
// Only Pi's virtual imports and Node builtins are needed in the child process.
export const VRATA_EXTENSION_SOURCE = String.raw`
import { readFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

const providerId = ${JSON.stringify(VRATA_PROVIDER_ID)};
const models = JSON.parse(process.env.VRATA_MODEL_CATALOG || "[]");

function readSnapshot() {
  try {
    const config = JSON.parse(readFileSync(process.env.VRATA_CREDENTIALS_PATH, "utf8"));
    if (!config || typeof config.apiKey !== "string" || !config.apiKey || typeof config.baseUrl !== "string") return undefined;
    const url = new URL(config.baseUrl);
    if (url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return undefined;
    return Object.freeze({ apiKey: config.apiKey, baseUrl: url.origin + "/v1" });
  } catch {
    return undefined;
  }
}

export default function vrataExtension(pi) {
  let snapshot;
  let running = false;
  const secrets = new Set();
  function refreshSnapshot() {
    snapshot = readSnapshot();
    if (snapshot) {
      secrets.add(snapshot.apiKey);
      secrets.add(JSON.stringify(snapshot.apiKey).slice(1, -1));
      secrets.add(encodeURIComponent(snapshot.apiKey));
    }
  }
  refreshSnapshot();

  function redactText(text) {
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    return text;
  }
  function redact(value) {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
    return value;
  }
  function requestModel(model, config) {
    return config ? { ...model, baseUrl: model.api === "anthropic-messages" ? new URL(config.baseUrl).origin : config.baseUrl } : model;
  }

  // The named registration builds Pi's ordinary per-model API dispatcher.
  // The marker satisfies startup availability without putting a bb secret through
  // Pi's !command / $ENV configuration language.
  pi.registerProvider(providerId, {
    baseUrl: snapshot?.baseUrl ?? "https://api.vrata.tg/v1",
    apiKey: "vrata-bb-runtime-auth",
    models: models.map((model) => requestModel(model, snapshot)),
  });

  pi.on("session_start", (_event, ctx) => {
    const native = ctx.modelRegistry.getProvider(providerId);
    if (!native) throw new Error("Провайдер Врата AI не зарегистрирован");

    function stream(method, model, context, options) {
      const config = snapshot;
      const output = new AssistantMessageEventStream();
      const pending = new Map();
      let lastPartial;
      function flush(key, message) {
        const held = pending.get(key);
        if (!held) return;
        pending.delete(key);
        output.push({ type: held.type, contentIndex: held.contentIndex,
          delta: held.text, partial: redact(message) });
      }
      function publish(event) {
        lastPartial = event.partial ?? event.message ?? event.error ?? lastPartial;
        const safe = redact(event);
        if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type)) {
          const key = event.type + ":" + event.contentIndex;
          const text = redactText((pending.get(key)?.text ?? "") + event.delta);
          // Hold only a suffix which could become a secret in the next chunk.
          // Each content stream retains at most the longest known key minus one.
          let keep = 0;
          for (const secret of secrets) {
            for (let n = Math.min(text.length, secret.length - 1); n > keep; n--) {
              if (text.endsWith(secret.slice(0, n))) { keep = n; break; }
            }
          }
          safe.delta = text.slice(0, text.length - keep);
          if (keep) pending.set(key, { type: event.type, contentIndex: event.contentIndex, text: text.slice(-keep) });
          else pending.delete(key);
        } else if (["text_end", "thinking_end", "toolcall_end"].includes(event.type)) {
          flush(event.type.replace("_end", "_delta") + ":" + event.contentIndex, lastPartial);
        } else if (event.type === "done" || event.type === "error") {
          for (const key of pending.keys()) flush(key, lastPartial);
        }
        output.push(safe);
      }
      const requestOptions = {
        ...options,
        headers: { ...options?.headers, "User-Agent": process.env.VRATA_USER_AGENT },
        // Auth may have been resolved before a before_agent_start hook. Bind
        // key and endpoint to the same operation snapshot at dispatch as well.
        ...(config ? { apiKey: config.apiKey } : {}),
        ...(options?.onResponse ? { onResponse: (response, selected) => options.onResponse({ ...response, headers: redact(response.headers) }, selected) } : {}),
        ...(options?.onProviderStreamEvent ? { onProviderStreamEvent: (data, selected) => options.onProviderStreamEvent(redact(data), selected) } : {}),
      };
      // Keep stock transport/options/retries. The wrapper only removes known
      // secrets from output and diagnostics, including native summary calls.
      void (async () => {
        if (!config) throw new Error("Добавьте ключ API Врата AI в настройках плагина");
        const source = native[method](requestModel(model, config), context, requestOptions);
        for await (const event of source) publish(event);
        output.end(redact(await source.result()));
      })().catch((error) => {
        const stopReason = options?.signal?.aborted ? "aborted" : "error";
        const message = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          timestamp: Date.now(), stopReason,
          errorMessage: redactText(error instanceof Error ? error.message : String(error)),
        };
        for (const key of pending.keys()) flush(key, lastPartial ?? message);
        publish({ type: "error", reason: stopReason, error: message });
      });
      return output;
    }

    pi.registerProvider({
      ...native,
      auth: {
        apiKey: {
          name: "Vrata machine credentials",
          check: async ({ signal }) => {
            signal.throwIfAborted();
            return snapshot ? { type: "api_key", source: "Vrata machine credentials" } : undefined;
          },
          resolve: async ({ signal }) => {
            signal.throwIfAborted();
            return snapshot ? { auth: { apiKey: snapshot.apiKey }, source: "Vrata machine credentials" } : undefined;
          },
        },
      },
      stream: (model, context, options) => stream("stream", model, context, options),
      streamSimple: (model, context, options) => stream("streamSimple", model, context, options),
    });
  });

  pi.on("before_agent_start", () => {
    refreshSnapshot();
    running = true;
  });
  // agent_end can still be followed by native retries or queued continuations.
  pi.on("agent_settled", () => { running = false; });
  pi.on("session_before_compact", () => { if (!running) refreshSnapshot(); });
  pi.on("session_before_tree", () => { if (!running) refreshSnapshot(); });
}
`;
