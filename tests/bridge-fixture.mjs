import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { experimental_createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge } from "../dist/host.js";

export const bridge = experimental_providerBridge;
export const options = {
  model: "mock-code", reasoningLevel: "none", permissionMode: "full",
  permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
};
export const textInput = (text) => [{ type: "text", text, mentions: [] }];
export const defaultModels = ["mock-code", "mock-other"].map((id) => ({
  id,
  gateway_metadata: {
    supports_tools: true, supports_images: true, supports_reasoning: true,
    max_input_tokens: 32000, max_output_tokens: 4096,
    verified_transport: "chat_completions",
  },
}));
export const dynamicTool = {
  name: "review_lookup", description: "Look up the supplied value.",
  inputSchema: {
    type: "object", properties: { value: { type: "string" } }, required: ["value"],
    additionalProperties: false,
  },
};
export const sleep = delay;

export async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

export function chunk(response, delta, { finishReason = null, usage } = {}) {
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({
    id: "chat-regression", object: "chat.completion.chunk", created: 1, model: "mock-code",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`);
}
export function finish(response, usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) {
  chunk(response, {}, { finishReason: "stop", usage });
  response.end("data: [DONE]\n\n");
}
export function answer(response, text = "Loopback answer") {
  chunk(response, { role: "assistant", content: text });
  finish(response);
}
export function callTool(response, name = dynamicTool.name, args = { value: "fixture" }) {
  chunk(response, { role: "assistant", tool_calls: [{
    index: 0, id: "call-regression", type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }] });
  chunk(response, {}, { finishReason: "tool_calls" });
  response.end("data: [DONE]\n\n");
}

export async function createGateway({ models = defaultModels, onModels, onChat, onResponses } = {}) {
  const requests = [];
  const catalogRequests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/v1/models") {
        catalogRequests.push(request);
        const respond = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: models }));
        };
        if (onModels) await onModels({ request, response, respond });
        else respond();
      } else if (request.url === "/v1/chat/completions" || (request.url === "/v1/responses" && onResponses)) {
        let raw = "";
        for await (const data of request) raw += data;
        const body = JSON.parse(raw);
        requests.push({ path: request.url, body, authorization: request.headers.authorization });
        const handler = request.url === "/v1/responses" ? onResponses : onChat;
        if (handler) await handler({ request, response, body, index: requests.length - 1 });
        else answer(response);
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests, catalogRequests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      assert.deepEqual(errors, [], "Loopback API handler failed");
    },
  };
}

export async function fixture(t, gatewayOptions) {
  const root = mkdtempSync(join(tmpdir(), "vrata-bridge-regression-"));
  let dataDir = join(root, "data");
  mkdirSync(dataDir);
  const gateways = [];
  const gateway = await createGateway(gatewayOptions);
  gateways.push(gateway);
  let harness;
  let counter = 0;
  let current;
  t.after(async () => {
    bridge.onClose?.();
    try {
      await Promise.all(gateways.map((item) => item.close()));
      await delay(20);
    } finally {
      harness?.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
  function configure(target = gateway, apiKey = "synthetic-key-a") {
    writeFileSync(join(dataDir, "credentials.json"), JSON.stringify({
      apiKey, baseUrl: target.url,
    }), { mode: 0o600 });
  }
  configure();
  bridge.start({ pluginId: "vrata", dataDir, tempDir: join(root, "temp") });
  harness = experimental_createBridgeJsonRpcTestHarness(bridge.handleLine);
  async function rpc(method, params) {
    const id = `request-${++counter}`;
    harness.sendRequest(id, method, params);
    const response = await harness.waitForResponse(id);
    assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response.error)}`);
    return { id, result: response.result };
  }
  const deltas = (threadId = current.threadId) => harness.messages
    .filter((message) => message.method === "thread/delta" && message.params?.threadId === threadId)
    .flatMap((message) => message.params.deltas);
  const clientId = () => `creq_${(++counter).toString(16).replace(/0/g, "x").replace(/1/g, "y").padStart(10, "a")}`;
  await rpc("initialize", { client: { name: "regression", version: "1" }, protocolVersion: 2 });
  return {
    root, gateway, configure, rpc, deltas, clientId,
    get dataDir() { return dataDir; },
    get current() { return current; },
    get messages() { return harness.messages; },
    async anotherGateway(gatewayOptions) {
      const result = await createGateway(gatewayOptions);
      gateways.push(result);
      return result;
    },
    async start(extra = {}) {
      const { options: extraOptions, ...rest } = extra;
      const params = {
        threadId: "thr_regression", cwd: root, instructionMode: "replace",
        ...rest, options: { ...options, instructions: "Follow the user request.", ...extraOptions },
      };
      const { result } = await rpc("thread/start", params);
      current = { threadId: params.threadId, providerThreadId: result.providerThreadId };
      return current;
    },
    async resume(providerThreadId, extraOptions = { model: "vrata-setup" }) {
      current = { threadId: "thr_resumed", providerThreadId };
      return rpc("thread/resume", {
        ...current, cwd: root, instructionMode: "replace", options: { ...options, ...extraOptions },
      });
    },
    async turn(text, extraOptions = {}) {
      return rpc("turn/start", {
        ...current, input: typeof text === "string" ? textInput(text) : text,
        clientRequestId: clientId(), options: { ...options, ...extraOptions },
      });
    },
    async steer(text) {
      const id = clientId();
      await rpc("turn/steer", {
        ...current, expectedTurnId: "turn-active", input: textInput(text),
        clientRequestId: id, options,
      });
      return id;
    },
    stop(intent = "interrupt") {
      return rpc("thread/stop", { ...current, activeTurnId: intent === "release" ? null : "turn-active", intent });
    },
    async boundary(count = 1) {
      await until(() => deltas().filter((delta) => delta.kind === "turn.boundary").length >= count, `boundary ${count}`);
      return deltas().filter((delta) => delta.kind === "turn.boundary").at(-1);
    },
    savedPath(providerThreadId = current.providerThreadId) { return join(dataDir, "sessions", `${providerThreadId}.json`); },
    saved(providerThreadId = current.providerThreadId) {
      return JSON.parse(readFileSync(join(dataDir, "sessions", `${providerThreadId}.json`), "utf8"));
    },
    reply(id, result) { bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, result })); },
    toolCall() {
      return until(() => harness.messages.find((message) => message.method === "item/tool/call"), "dynamic tool call");
    },
    restart() {
      dataDir = join(root, `restart-${++counter}`);
      mkdirSync(dataDir);
      configure();
      bridge.start({ pluginId: "vrata", dataDir, tempDir: join(root, "temp") });
    },
  };
}
