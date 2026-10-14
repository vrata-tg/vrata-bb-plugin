import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge } from "../dist/host.js";

const root = mkdtempSync(join(tmpdir(), "vrata-plugin-test-"));
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer test-key") {
    response.writeHead(401).end();
    return;
  }
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-code", gateway_metadata: { name: "Mock Code", max_input_tokens: 32000, max_output_tokens: 4096, supports_tools: true } }] }));
    return;
  }
  if (request.url === "/v1/chat/completions") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"mock-code","choices":[{"index":0,"delta":{"role":"assistant","content":"Привет из Врата"},"finish_reason":null}]}\n\n');
    response.write('data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"mock-code","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n');
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(404).end();
});
let harness;
let port;
let count = 0;

async function setup() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  mkdirSync(join(root, "data"));
  experimental_providerBridge.start({ pluginId: "vrata", dataDir: join(root, "data"), tempDir: join(root, "temp") });
  harness = experimental_createBridgeJsonRpcTestHarness(experimental_providerBridge.handleLine);
}
async function teardown() {
  harness?.restore();
  experimental_providerBridge.onClose?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

async function request(method, params) {
  const id = `req-${++count}`;
  harness.sendRequest(id, method, params);
  const response = await harness.waitForResponse(id);
  assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
  return response.result;
}
const options = { model: "mock-code", reasoningLevel: "none", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const input = (text) => [{ type: "text", text, mentions: [] }];

async function awaitBoundary(threadId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const deltas = harness.messages.filter((message) => message.method === "thread/delta" && message.params?.threadId === threadId).flatMap((message) => message.params.deltas);
    if (deltas.some((item) => item.kind === "turn.boundary")) return deltas;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Pi turn did not settle");
}

async function awaitInteraction() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const interaction = harness.messages.find((message) => message.method === "interaction/request");
    if (interaction) return interaction;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Missing in-thread key request");
}

async function smoke() {
  const init = await request("initialize", { client: { name: "test", version: "1" }, protocolVersion: 2 });
  assert.equal(init.protocolVersion, 2);
  const initialCatalog = await request("model/list", {});
  assert.equal(initialCatalog.models[0].id, "vrata-auto");
  const first = await request("thread/start", { threadId: "thr_vrata_first", cwd: root, instructionMode: "append", options: { ...options, model: "vrata-auto" }, input: input("Ответь кратко") });
  assert.ok(first.providerThreadId);
  const interaction = await awaitInteraction();
  assert.equal(interaction.params.payload.kind, "vrata/api-key");
  assert.deepEqual(interaction.params.payload.data, {});
  writeFileSync(join(root, "data", "credentials.json"), JSON.stringify({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}` }), { mode: 0o600 });
  experimental_providerBridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: interaction.id, result: { kind: "request_answer", value: { configured: true } } }));
  const firstDeltas = await awaitBoundary("thr_vrata_first");
  assert.ok(firstDeltas.some((item) => item.kind === "item.textClose" && item.text === "Привет из Врата"), JSON.stringify(firstDeltas));
  assert.ok(firstDeltas.some((item) => item.kind === "turn.boundary" && item.status === "completed"), JSON.stringify(firstDeltas));
  const catalog = await request("model/list", {});
  assert.ok(catalog.models.some((model) => model.id === "mock-code"));
  const start = await request("thread/start", { threadId: "thr_vrata_test", cwd: root, instructionMode: "append", options });
  assert.ok(start.providerThreadId);
  await request("turn/start", { threadId: "thr_vrata_test", providerThreadId: start.providerThreadId, input: input("Ответь кратко"), options, clientRequestId: "creq_23456789ab" });
  const deltas = await awaitBoundary("thr_vrata_test");
  assert.ok(deltas.some((item) => item.kind === "item.textClose" && item.text === "Привет из Врата"), JSON.stringify(deltas));
  assert.ok(deltas.some((item) => item.kind === "turn.boundary" && item.status === "completed"), JSON.stringify(deltas));
  await request("thread/stop", { threadId: "thr_vrata_test", providerThreadId: start.providerThreadId, activeTurnId: "turn-test", intent: "release" });
  const resume = await request("thread/resume", { threadId: "thr_vrata_resume", providerThreadId: start.providerThreadId, cwd: root, instructionMode: "append", options });
  assert.equal(resume.providerThreadId, start.providerThreadId);
}

try {
  await setup();
  await smoke();
  harness.restore();
  process.stdout.write("Bundled Pi gateway and session smoke passed\n");
} finally {
  await teardown();
}
