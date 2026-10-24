import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPiModels, supportedReasoningLevels, fetchModels, readConfig, apiBaseUrl } from "../dist/tests/vrata.js";

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
    if (!request.headers["anthropic-version"]) response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"mock-code"}]}');
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
    else response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"mock-code","gateway_metadata":{"verified_transport":"messages"}}]}');
  });
  const models = await fetchModels(config);
  assert.equal(models.length, 1);
  assert.equal(buildPiModels(models, config.baseUrl)[0].api, "openai-responses", "Messages metadata cannot override the OpenAI protocol");
});

test("catalog metadata updates new models without a plugin model table", async (t) => {
  let price = "0.000003", contextWindow = 321_000;
  const config = await gateway(t, (request, response) => {
    const anthropic = !!request.headers["anthropic-version"];
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
      id: "new-name-without-a-family", baseUrl: "https://untrusted.invalid", headers: { authorization: "untrusted" },
      gateway_metadata: { name: "Server model", protocol: anthropic ? "anthropic" : "openai",
        verified_transport: anthropic ? "messages" : "chat_completions",
        max_input_tokens: contextWindow, max_output_tokens: 12_345, supports_tools: true, supports_images: false },
      gateway_pricing: { currency: "RUB", unit: "token", prompt: price, completion: "0.000009",
        input_cache_read: "0.000001", input_cache_write: "0.000004" },
    }] }));
  });
  const load = async () => buildPiModels(await fetchModels(config), config.baseUrl);
  const [first] = await load();
  assert.equal(first.api, "anthropic-messages", "Anthropic catalog retains duplicate precedence");
  assert.equal(first.baseUrl, new URL(config.baseUrl).origin);
  assert.equal(first.headers, undefined);
  assert.equal(first.name, "Server model");
  assert.deepEqual(first.input, ["text"]);
  assert.equal(first.contextWindow, contextWindow);
  assert.equal(first.maxTokens, 12_345);
  assert.deepEqual(first.cost, { input: 3, output: 9, cacheRead: 1, cacheWrite: 4 });
  price = "0.000007"; contextWindow = 654_000;
  const [updated] = await load();
  assert.equal(updated.cost.input, 7);
  assert.equal(updated.contextWindow, contextWindow);
});

test("catalog validation keeps unsafe values out of Pi while honoring explicit capabilities", async (t) => {
  const config = await gateway(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: request.headers["anthropic-version"] ? [] : [
      { id: "no-tools", gateway_metadata: { supports_tools: false, max_input_tokens: "invalid" } },
      { id: "legacy" },
      { id: "invalid-values", gateway_metadata: { max_input_tokens: -1, max_output_tokens: 1e100,
        supports_images: false, verified_transport: "https://untrusted.invalid" },
        gateway_pricing: { currency: "RUB", unit: "token", prompt: "1".repeat(400), completion: "-3" } },
      { id: "wrong-currency", gateway_pricing: { currency: "USD", unit: "token", prompt: "1" } },
    ] }));
  });
  const models = buildPiModels(await fetchModels(config), config.baseUrl);
  assert.deepEqual(models.map(({ id }) => id), ["legacy", "invalid-values", "wrong-currency"]);
  for (const model of models) {
    assert.equal(model.contextWindow, 128_000);
    assert.equal(model.maxTokens, 16_384);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
  assert.deepEqual(models[1].input, ["text"]);
});

test("transport selection follows catalog metadata independently of the model name", () => {
  for (const id of ["gemini-fixture", "unrelated-fixture"]) {
    const catalog = ["chat_completions", "responses", undefined].map((verified_transport) => ({
      id, protocol: "openai", gateway_metadata: { verified_transport },
    }));
    assert.deepEqual(buildPiModels(catalog, "https://example.test").map((model) => model.api),
      ["openai-completions", "openai-responses", "openai-responses"]);
  }
});

test("projection retains Pi reasoning maps and native Anthropic compatibility", () => {
  const catalog = [
    { id: "gpt-6-astra", protocol: "openai", gateway_metadata: { verified_transport: "chat_completions" } },
    { id: "gpt-6-luna", protocol: "openai" },
    { id: "claude-sonnet-5-5", protocol: "anthropic" },
  ];
  const [astra, luna, sonnet] = buildPiModels(catalog, "https://example.test");
  assert.deepEqual(supportedReasoningLevels(astra), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(supportedReasoningLevels(luna), ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(supportedReasoningLevels(sonnet), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(sonnet.compat.forceAdaptiveThinking, true);
});

test("catalog parse errors return a fixed diagnostic without raw response text", { timeout: 5000 }, async (t) => {
  const config = await gateway(t, (_request, response) => response.writeHead(200).end("LEAK123 synthetic-key broken JSON"));
  await assert.rejects(fetchModels(config), (error) => error.message === "Некорректный ответ каталога моделей");
});
