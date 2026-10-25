import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPiModels, buildPiAvailableModels, supportedReasoningLevels, fetchModels, readConfig, apiBaseUrl } from "../dist/tests/vrata.js";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as chatStream } from "@earendil-works/pi-ai/api/openai-completions";

async function gateway(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { apiKey: "synthetic-key", baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("readConfig preserves opaque keys and rejects unusable config without raw diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "vrata-config-"));
  try {
    assert.equal(readConfig(dir), undefined);
    const config = { apiKey: "!opaque-$ENV-${NOT_EXPANDED}", baseUrl: "https://example.test" };
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(config));
    const loaded = readConfig(dir);
    assert.ok(loaded?.apiKey === config.apiKey, "opaque key changed");
    assert.equal(loaded.baseUrl, "https://example.test/v1");
    for (const value of ["{invalid synthetic-secret", JSON.stringify({ apiKey: "secret", baseUrl: "https://secret@example.test" })]) {
      writeFileSync(join(dir, "credentials.json"), value);
      assert.equal(readConfig(dir), undefined);
    }
    assert.throws(() => apiBaseUrl("not a url with synthetic-secret"), (error) => !error.message.includes("synthetic-secret"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("catalog caller cancellation rejects even when one catalog has succeeded", { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const bothRequested = Promise.withResolvers();
  let count = 0;
  const config = await gateway(t, (request, response) => {
    if (!request.headers["anthropic-version"]) response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"mock-code","gateway_metadata":{"max_input_tokens":1000000,"max_output_tokens":128000}}]}');
    if (++count === 2) bothRequested.resolve();
  });
  const pending = fetchModels(config, controller.signal);
  await bothRequested.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("catalog discovery retains the successful protocol when the other fails", { timeout: 5000 }, async (t) => {
  const config = await gateway(t, (request, response) => {
    if (request.headers["anthropic-version"]) response.writeHead(404).end();
    else response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"mock-code","gateway_metadata":{"verified_transport":"messages","max_input_tokens":1000000,"max_output_tokens":128000}}]}');
  });
  const models = await fetchModels(config);
  assert.equal(models.length, 1);
  assert.equal(buildPiModels(models, config.baseUrl)[0].api, "openai-responses", "Messages metadata cannot override the OpenAI protocol");
});

test("catalog metadata updates new models without a plugin model table", async (t) => {
  let price = "0.000003", contextWindow = 321_000, maxTokens = 128_000;
  const config = await gateway(t, (request, response) => {
    const anthropic = !!request.headers["anthropic-version"];
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
      id: "new-name-without-a-family", baseUrl: "https://untrusted.invalid", headers: { authorization: "untrusted" },
      gateway_metadata: { name: "Server model", protocol: anthropic ? "anthropic" : "openai",
        verified_transport: anthropic ? "messages" : "chat_completions",
        max_input_tokens: contextWindow, max_output_tokens: maxTokens, supports_tools: true, supports_images: false },
      gateway_pricing: { currency: "RUB", unit: "token", prompt: price, completion: "0.000009",
        input_cache_read: "0.000001", input_cache_write: "0.000004" },
    }] }));
  });
  const load = async () => buildPiModels(await fetchModels(config), config.baseUrl);
  const [first] = await load();
  assert.equal(first.api, "openai-completions", "Verified OpenAI transport retains native effort for an unknown model");
  assert.equal(first.baseUrl, config.baseUrl);
  assert.equal(first.headers, undefined);
  assert.equal(first.name, "Server model");
  assert.deepEqual(first.input, ["text"]);
  assert.equal(first.contextWindow, contextWindow);
  assert.equal(first.maxTokens, maxTokens);
  assert.deepEqual(first.cost, { input: 3, output: 9, cacheRead: 1, cacheWrite: 4 });
  price = "0.000007"; contextWindow = 654_000; maxTokens = 256_000;
  const [updated] = await load();
  assert.equal(updated.cost.input, 7);
  assert.equal(updated.contextWindow, contextWindow);
  assert.equal(updated.maxTokens, maxTokens);
});

test("catalog validation keeps unsafe values out of Pi while honoring explicit capabilities", async (t) => {
  const config = await gateway(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: request.headers["anthropic-version"] ? [] : [
      { id: "no-tools", gateway_metadata: { supports_tools: false, max_input_tokens: 1_000_000, max_output_tokens: 128_000 } },
      { id: "legacy" },
      { id: "missing-input", gateway_metadata: { max_output_tokens: 128_000 } },
      { id: "missing-output", gateway_metadata: { max_input_tokens: 1_000_000 } },
      { id: "invalid-limits", gateway_metadata: { max_input_tokens: -1, max_output_tokens: 1e100 } },
      { id: "invalid-values", gateway_metadata: { max_input_tokens: 1_000_000, max_output_tokens: 128_000,
        supports_images: false, verified_transport: "https://untrusted.invalid" },
        gateway_pricing: { currency: "RUB", unit: "token", prompt: "1".repeat(400), completion: "-3" } },
      { id: "wrong-currency", gateway_metadata: { max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
        gateway_pricing: { currency: "USD", unit: "token", prompt: "1" } },
    ] }));
  });
  const models = buildPiModels(await fetchModels(config), config.baseUrl);
  assert.deepEqual(models.map(({ id }) => id), ["invalid-values", "wrong-currency"]);
  for (const model of models) {
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
  assert.deepEqual(models[0].input, ["text"]);
});

test("transport selection follows catalog metadata independently of the model name", () => {
  for (const id of ["gemini-fixture", "unrelated-fixture"]) {
    const catalog = ["chat_completions", "responses", undefined].map((verified_transport) => ({
      id, protocol: "openai", gateway_metadata: { verified_transport, max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
    }));
    assert.deepEqual(buildPiModels(catalog, "https://example.test").map((model) => model.api),
      ["openai-completions", "openai-responses", "openai-responses"]);
  }
});

test("projection retains Pi reasoning maps and native Anthropic compatibility", () => {
  const catalog = [
    { id: "gpt-6-astra", protocol: "openai", gateway_metadata: { verified_transport: "chat_completions", max_input_tokens: 1_000_000, max_output_tokens: 128_000 } },
    { id: "gpt-6-luna", protocol: "openai", gateway_metadata: { max_input_tokens: 1_000_000, max_output_tokens: 128_000 } },
    { id: "claude-sonnet-5-5", protocol: "anthropic", gateway_metadata: { max_input_tokens: 1_000_000, max_output_tokens: 128_000 } },
  ];
  const [astra, luna, sonnet] = buildPiModels(catalog, "https://example.test");
  assert.deepEqual(supportedReasoningLevels(astra), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(supportedReasoningLevels(luna), ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(supportedReasoningLevels(sonnet), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(sonnet.compat.forceAdaptiveThinking, true);
});

const metadata = { max_input_tokens: 1_000_000, max_output_tokens: 128_000 };
const row = (id, protocol, extra = {}) => ({ id, protocol, gateway_metadata: { ...metadata, ...extra } });

test("native catalog levels replace the entire Pi ladder without effort aliases", async (t) => {
  const cases = [
    ["sparse", ["low", "high", "max"], ["low", "high", "max"]],
    ["empty", [], []],
    ["disable", ["none"], ["none"]],
    ["native", ["none", "minimal", "low", "medium", "high", "xhigh", "max"], ["none", "low", "medium", "high", "xhigh", "max"]],
    ["future", ["future-effort"], []],
    ["gpt-6-astra", ["low"], ["low"]],
  ];
  const config = await gateway(t, (request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    data: request.headers["anthropic-version"] ? [] : cases.map(([id, reasoning_levels]) => row(id, "openai", { reasoning_levels })),
  })));
  const discovered = await fetchModels(config);
  const models = buildPiModels(discovered, config.baseUrl);
  for (const [index, [id, native, expected]] of cases.entries()) {
    assert.deepEqual(discovered[index].gateway_metadata.reasoning_levels, native, id);
    assert.deepEqual(supportedReasoningLevels(models[index]), expected, id);
    assert.deepEqual(buildPiAvailableModels([models[index]]).models[0].supportedReasoningEfforts.map(e => e.reasoningEffort), expected, id);
    assert.deepEqual(models[index].thinkingLevelMap, Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => {
      const effort = level === "off" ? "none" : level;
      return [level, native.includes(effort) ? effort : null];
    })), id);
  }
});

test("unknown reasoning metadata keeps legacy behavior and explicit false disables reasoning", async (t) => {
  const config = await gateway(t, (request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    data: request.headers["anthropic-version"] ? [] : [
      row("absent", "openai"), row("null", "openai", { reasoning_levels: null }),
      row("invalid", "openai", { reasoning_levels: ["low", 7] }),
      row("false", "openai", { supports_reasoning: false, reasoning_levels: ["high"] }),
      row("false-legacy", "openai", { supports_reasoning: false }),
    ],
  })));
  const models = buildPiModels(await fetchModels(config), config.baseUrl);
  for (const model of models.slice(0, 3)) assert.deepEqual(supportedReasoningLevels(model), ["none", "low", "medium", "high"]);
  for (const model of models.slice(3)) {
    assert.equal(model.reasoning, false);
    assert.deepEqual(supportedReasoningLevels(model), []);
  }
});

test("duplicate catalogs prefer verified native transport and retain legacy selection when unknown", async (t) => {
  const ids = ["glm-5.3-flash", "gpt-6-astra", "gemini-3.8-flash", "grok-4", "claude-sonnet-5-5", "legacy", "unverified", "mismatched"];
  const config = await gateway(t, (request, response) => {
    const protocol = request.headers["anthropic-version"] ? "anthropic" : "openai";
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: ids.map(id => row(id, protocol,
      id === "legacy" ? {} : id === "mismatched" ? { protocol: protocol === "openai" ? "anthropic" : "openai", verified_transport: "responses" }
      : id === "unverified" ? (protocol === "openai" ? { protocol, verified_transport: "responses" } : {})
      : { protocol, verified_transport: protocol === "anthropic" ? "messages" : id === "claude-sonnet-5-5" ? "chat_completions" : "responses", reasoning_levels: ["low", "high", "max"] },
    )) }));
  });
  const models = buildPiModels(await fetchModels(config), config.baseUrl);
  assert.deepEqual(models.map(m => m.api), ["openai-responses", "openai-responses", "openai-responses", "openai-responses", "anthropic-messages", "anthropic-messages", "openai-responses", "anthropic-messages"]);
  assert.equal(models[4].compat.supportsMidConvoEffort, true);
});

test("pinned Pi adapters preserve native effort transports and Anthropic thinking mechanisms", async (t) => {
  const currentClaudeIds = ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-5-5", "claude-sonnet-5-5"];
  const currentClaudeLevels = ["low", "medium", "high", "xhigh", "max"];
  const requests = [];
  const config = await gateway(t, async (request, response) => {
    if (request.url === "/v1/models") {
      const protocol = request.headers["anthropic-version"] ? "anthropic" : "openai";
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        row("glm-5.3-flash", protocol, { protocol, verified_transport: protocol === "openai" ? "responses" : "messages", reasoning_levels: ["low", "high", "max"] }),
        ...currentClaudeIds.map(id => row(id, protocol, { protocol, verified_transport: protocol === "openai" ? "chat_completions" : "messages", reasoning_levels: currentClaudeLevels })),
        row("claude-opus-4-6", protocol, { protocol, verified_transport: protocol === "openai" ? "chat_completions" : "messages", reasoning_levels: ["none", "low", "high", "max"] }),
        ...(protocol === "openai" ? [row("new-chat", protocol, { protocol, verified_transport: "chat_completions", reasoning_levels: ["none", "low", "max"] })] : []),
        ...(protocol === "anthropic" ? ["claude-opus-4-5", "messages-only"].map(id => row(id, protocol, { protocol, verified_transport: "messages", reasoning_levels: ["low", "high"] })) : []),
      ] }));
      return;
    }
    let raw = "";
    for await (const data of request) raw += data;
    requests.push({ path: new URL(request.url, config.baseUrl).pathname, body: JSON.parse(raw) });
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "wire probe complete" } }));
  });
  const models = buildPiModels(await fetchModels(config), config.baseUrl);
  for (const id of currentClaudeIds) assert.deepEqual(supportedReasoningLevels(models.find(model => model.id === id)), currentClaudeLevels, id);
  for (const model of models) for (const level of supportedReasoningLevels(model)) {
    const stream = model.api === "anthropic-messages" ? anthropicStream : model.api === "openai-responses" ? responsesStream : chatStream;
    const result = await stream(model, { messages: [{ role: "user", content: "synthetic probe", timestamp: 1 }] }, {
      apiKey: "synthetic-key", reasoning: level === "none" ? undefined : level, maxRetries: 0,
    }).result();
    assert.match(result.errorMessage, /wire probe complete/);
    const { path, body } = requests.at(-1);
    assert.equal(body.model, model.id);
    if (model.id === "glm-5.3-flash") {
      assert.equal(path, "/v1/responses");
      assert.equal(body.reasoning.effort, level);
    } else if (model.id === "new-chat") {
      assert.equal(path, "/v1/chat/completions");
      assert.equal(body.reasoning_effort, level);
    } else if (currentClaudeIds.includes(model.id) && model.id !== "claude-opus-4-8") {
      assert.equal(path, "/v1/messages");
      assert.equal(body.thinking.type, "adaptive");
      assert.equal(body.thinking.budget_tokens, undefined);
      assert.equal(body.messages.at(-1).output_config.effort, level, "Pi's native managed-effort system message");
    } else if (model.id === "claude-opus-4-8" || model.id === "claude-opus-4-6") {
      assert.equal(path, "/v1/messages");
      assert.equal(body.thinking.type, level === "none" ? "disabled" : "adaptive");
      assert.equal(body.thinking.budget_tokens, undefined);
      assert.equal(body.output_config?.effort, level === "none" ? undefined : level);
    } else {
      assert.equal(path, "/v1/messages");
      assert.equal(body.thinking.type, "enabled");
      assert.ok(body.thinking.budget_tokens > 0, "Pinned Pi uses budgets without native adaptive compatibility");
      assert.equal(body.output_config, undefined, "Budget-based Messages cannot preserve an exact effort");
    }
  }
});

test("explicitly unavailable Claude reasoning leaves thinking and effort to the model default", async (t) => {
  const requests = [];
  const config = await gateway(t, async (request, response) => {
    let raw = "";
    for await (const data of request) raw += data;
    requests.push(JSON.parse(raw));
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "wire probe complete" } }));
  });
  const id = "claude-sonnet-5-5";
  const [normal] = buildPiModels([row(id, "anthropic")], config.baseUrl);
  for (const [name, extra] of [
    ["supports_reasoning:false", { supports_reasoning: false }],
    ["reasoning_levels:[]", { reasoning_levels: [] }],
  ]) await t.test(name, async () => {
    const [model] = buildPiModels([row(id, "anthropic", extra)], config.baseUrl);
    assert.deepEqual(supportedReasoningLevels(model), []);
    const result = await anthropicStream(model, { messages: [{ role: "user", content: "synthetic probe", timestamp: 1 }] }, {
      apiKey: "synthetic-key", maxRetries: 0,
    }).result();
    assert.match(result.errorMessage, /wire probe complete/);
    const body = requests.at(-1);
    assert.equal(body.output_config, undefined, "No default high effort on the request");
    assert.ok(body.messages.every(message => message.output_config === undefined), "No managed-effort message");
    assert.equal(body.thinking, undefined, "No assumption that native thinking can be disabled");
    assert.deepEqual(model.compat, { ...normal.compat, supportsMidConvoEffort: false });
    assert.equal(model.reasoning, extra.supports_reasoning ?? normal.reasoning);
  });
});

test("catalog parse errors return a fixed diagnostic without raw response text", { timeout: 5000 }, async (t) => {
  const config = await gateway(t, (_request, response) => response.writeHead(200).end("LEAK123 synthetic-key broken JSON"));
  await assert.rejects(fetchModels(config), (error) => error.message === "Некорректный ответ каталога моделей");
});
