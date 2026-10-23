import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchModels, readConfig, apiBaseUrl } from "../dist/tests/vrata.js";

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
  assert.deepEqual(models, [{ id: "mock-code", protocol: "openai" }]);
});

test("catalog parse errors return a fixed diagnostic without raw response text", { timeout: 5000 }, async (t) => {
  const config = await gateway(t, (_request, response) => response.writeHead(200).end("LEAK123 synthetic-key broken JSON"));
  await assert.rejects(fetchModels(config), (error) => error.message === "Некорректный ответ каталога моделей");
});
