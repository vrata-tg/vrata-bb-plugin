import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchModels, parseModels, piModel, supportedReasoningLevels } from "../dist/tests/vrata.js";
import { streamVrata } from "../dist/tests/transport.js";

const context = { messages: [{ role: "user", content: "Synthetic test", timestamp: 1 }] };

async function gateway(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { apiKey: "synthetic-key", baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function model(id, transport, config, protocol = "openai") {
  const [entry] = parseModels({ data: [{ id, gateway_metadata: {
    verified_transport: transport, supports_reasoning: true,
  } }] }, protocol);
  return piModel(entry, config);
}

for (const [id, transport, field] of [
  ["gpt-5.6-luna", "responses", "reasoning"],
  ["claude-opus-4-7", "messages", "output_config"],
]) {
  for (const reasoning of ["xhigh", "max"]) {
    test(`${id} sends ${reasoning} using its compatible pinned Pi metadata`, { timeout: 5000 }, async (t) => {
      const requests = [];
      const config = await gateway(t, async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push({ path: request.url, payload: JSON.parse(body) });
        response.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"synthetic rejection"}}');
      });
      const selected = model(id, transport, config);
      assert.ok(supportedReasoningLevels(selected).includes(reasoning));
      const result = await streamVrata(selected, context, { apiKey: config.apiKey, reasoning }).result();
      assert.equal(result.stopReason, "error");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].payload[field].effort, reasoning);
      if (transport === "messages") {
        // This model came from the OpenAI catalog; verified transport owns routing.
        assert.equal(requests[0].path, "/v1/messages");
        assert.equal(requests[0].payload.thinking.type, "adaptive");
      } else {
        assert.equal(requests[0].path, "/v1/responses");
      }
    });
  }
}

test("unknown or incompatible transports advertise only Pi's realizable reasoning levels", () => {
  const config = { apiKey: "synthetic-key", baseUrl: "http://127.0.0.1:1" };
  for (const selected of [
    model("unknown-model", "responses", config),
    model("claude-opus-4-7", "chat_completions", config),
  ]) {
    assert.deepEqual(supportedReasoningLevels(selected), ["none", "low", "medium", "high"]);
    assert.equal(selected.thinkingLevelMap, undefined);
    assert.equal(selected.compat, undefined);
  }
  const noReasoning = model("unknown-model", "responses", config);
  noReasoning.reasoning = false;
  assert.deepEqual(supportedReasoningLevels(noReasoning), ["none"]);
  assert.ok(!supportedReasoningLevels(model("claude-fable-5", "messages", config)).includes("none"));
  assert.equal(model("gpt-5.6-luna", "responses", config, "anthropic").api, "openai-responses");
});

for (const [transport, expectedPath] of [
  ["chat_completions", "/v1/chat/completions"],
  ["responses", "/v1/responses"],
  ["messages", "/v1/messages"],
]) {
  for (const status of [307, 308, 429, 503]) {
    test(`${transport}: HTTP ${status} creates one request without redirects or retries`, { timeout: 5000 }, async (t) => {
      const requests = [];
      const config = await gateway(t, async (request, response) => {
        for await (const _chunk of request) { /* Drain the synthetic request. */ }
        requests.push({ path: request.url, method: request.method });
        response.writeHead(status, { location: "/redirect-target", "content-type": "application/json" })
          .end('{"error":{"message":"synthetic rejection"}}');
      });
      const originalFetch = globalThis.fetch;
      const result = await streamVrata(model("unknown-model", transport, config), context, {
        apiKey: config.apiKey,
        maxRetries: 2,
      }).result();
      assert.equal(result.stopReason, "error");
      assert.deepEqual(requests, [{ path: expectedPath, method: "POST" }]);
      assert.equal(globalThis.fetch, originalFetch);
    });
  }
}

test("catalog caller cancellation rejects even when one catalog has succeeded", { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  const bothRequested = Promise.withResolvers();
  let count = 0;
  const config = await gateway(t, (request, response) => {
    if (!request.headers["anthropic-version"]) {
      response.writeHead(200, { "content-type": "application/json" })
        .end('{"data":[{"id":"mock-code"}]}');
    }
    if (++count === 2) bothRequested.resolve();
  });
  const pending = fetchModels(config, controller.signal);
  await bothRequested.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("catalog discovery retains the successful protocol when the other fails", { timeout: 5000 }, async (t) => {
  const config = await gateway(t, (request, response) => {
    if (request.headers["anthropic-version"]) {
      response.writeHead(404).end();
    } else {
      response.writeHead(200, { "content-type": "application/json" })
        .end('{"data":[{"id":"mock-code","gateway_metadata":{"verified_transport":"messages"}}]}');
    }
  });
  const models = await fetchModels(config);
  assert.equal(models.length, 1);
  assert.equal(piModel(models[0], config).api, "anthropic-messages");
});
