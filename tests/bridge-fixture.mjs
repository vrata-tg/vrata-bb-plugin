import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { experimental_createBridgeDeltaEventCollector, experimental_resolveProviderBridgeLaunch } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const models = {
  chat: "gemini-3.8-flash",
  responses: "gpt-6.1-sol",
  anthropic: "claude-sonnet-5-5",
};
export const dynamicModel = "server-added-model";
export const options = {
  model: models.chat, reasoningLevel: "none", permissionMode: "full",
  permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
};
export const textInput = (text) => [{ type: "text", text, mentions: [] }];
export const dynamicTool = {
  name: "review_lookup", description: "Look up the supplied value.",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
};
// Same valid tiny PNG used by packaging.test.mjs.
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==";
export const sleep = delay;
export async function until(predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

export function chunk(response, delta, { finishReason = null, usage } = {}) {
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({
    id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "gemini-3.8-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
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
  chunk(response, { role: "assistant", tool_calls: [{ index: 0, id: `call-fixture-${response.fixtureIndex ?? 0}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  chunk(response, {}, { finishReason: "tool_calls" });
  response.end("data: [DONE]\n\n");
}
function event(response, value) {
  if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
export function responsesAnswer(response, text = "Loopback answer") {
  const item = { type: "message", id: "msg-fixture", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
  event(response, { type: "response.created", response: { id: "resp-fixture" } });
  event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
  event(response, { type: "response.output_text.delta", output_index: 0, delta: text });
  event(response, { type: "response.output_item.done", output_index: 0, item });
  event(response, { type: "response.completed", response: { id: "resp-fixture", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
  response.end();
}
export function anthropicAnswer(response, text = "Loopback answer") {
  event(response, { type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  event(response, { type: "content_block_stop", index: 0 });
  event(response, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
  event(response, { type: "message_stop" });
  response.end();
}
export async function createGateway({ onChat, onResponses, onAnthropic, onModels } = {}) {
  const requests = [], catalogRequests = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://loopback").pathname;
      if (path === "/v1/models") {
        catalogRequests.push(request);
        const ids = request.headers["anthropic-version"] ? [models.anthropic] : [models.chat, models.responses, dynamicModel];
        const respond = () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
        if (onModels) await onModels({ request, response, respond }); else respond();
        return;
      }
      const routes = { "/v1/chat/completions": [onChat, answer], "/v1/responses": [onResponses, responsesAnswer], "/v1/messages": [onAnthropic, anthropicAnswer] };
      if (!routes[path]) throw new Error(`Unexpected fixture endpoint ${request.method} ${path}`);
      let raw = "";
      for await (const data of request) raw += data;
      const body = JSON.parse(raw);
      requests.push({ path, body, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"] });
      response.fixtureIndex = requests.length - 1;
      const [handler, respond] = routes[path];
      if (handler) await handler({ request, response, body, index: requests.length - 1 }); else respond(response);
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, catalogRequests,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.deepEqual(errors, [], "Loopback API handler failed"); },
  };
}

// The two real protocols share framing only. No fake Pi or substitute bridge.
export function jsonlChild(command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [], decoder = new StringDecoder("utf8");
  let buffer = "", stderr = "", sequence = 0, cursor = 0, exit;
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) {
        try { messages.push(JSON.parse(line)); }
        catch { stderr += `Invalid JSONL: ${line}\n`; }
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => { stderr += String(error); exit = { error }; });
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  const send = (line) => child.stdin.write(`${line}\n`);
  return {
    child, messages, send,
    get stderr() { return stderr; },
    takeMessages() { const result = messages.slice(cursor); cursor = messages.length; return result; },
    async request(method, params, raw = false) {
      const id = `fixture-${++sequence}`;
      send(JSON.stringify(raw ? { ...params, type: method, id } : { jsonrpc: "2.0", id, method, params }));
      const response = await until(() => {
        const message = messages.find((m) => m.id === id && (raw ? m.type === "response" : !("method" in m)));
        if (!message && exit) assert.fail(`Child exited: ${JSON.stringify(exit)} ${stderr}`);
        return message;
      }, `${method} response; stderr: ${stderr}`, 30000);
      assert.equal(response.error, undefined, `${method}: ${JSON.stringify(response)} ${stderr}`);
      if (raw) assert.equal(response.success, true, JSON.stringify(response));
      return { id, result: raw ? response.data : response.result };
    },
    async close() {
      if (exit) return;
      child.stdin.end();
      await Promise.race([until(() => exit, "child exit", 12000), delay(1000).then(() => { if (!exit) child.kill("SIGTERM"); })]);
      await until(() => exit, `child shutdown: ${stderr}`, 12000);
    },
  };
}

export async function fixture(t, gatewayOptions = {}, { configured = true, settings = {}, closeHook = false, traceChildren = false, pluginId = "vrata" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vrata-native-test-"));
  const cwd = join(root, "workspace"), dataDir = join(root, "bridge-data"), home = join(root, "home");
  for (const path of [cwd, dataDir, home]) mkdirSync(path);
  const gateways = [], children = [];
  const gateway = await createGateway(gatewayOptions); gateways.push(gateway);
  t.after(async () => {
    try { for (const child of children) await child.close(); await Promise.all(gateways.map((item) => item.close())); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  let transport, current, collector, eventRecords, messageCursor, requestId, turnCursor = 0, counter = 0;
  const configure = (target = gateway, apiKey = "synthetic-key-a") => writeFileSync(join(dataDir, "credentials.json"), JSON.stringify({ apiKey, baseUrl: target.url }), { mode: 0o600 });
  if (configured) configure();
  const { preparePiRuntime } = await import("../dist/tests/pi-runtime.js");
  const runtime = await preparePiRuntime(dataDir);
  if (Object.keys(settings).length) {
    const path = join(runtime.agentDir, "settings.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...settings }), { mode: 0o600 });
  }
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, LANG: "C.UTF-8", PI_OFFLINE: "1", ...runtime.env };
  const spawnLog = join(root, "spawned.jsonl");
  if (traceChildren) {
    const preload = join(root, "trace-children.cjs");
    // Observe real launches without replacing the CLI or adding a product RPC.
    writeFileSync(preload, `
      const { ChildProcess } = require("node:child_process");
      const { appendFileSync } = require("node:fs");
      const original = ChildProcess.prototype.spawn;
      ChildProcess.prototype.spawn = function(options) {
        const result = original.call(this, options);
        if (this.pid) appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({ parent: process.pid, pid: this.pid }) + "\\n");
        return result;
      };
    `);
    env.NODE_OPTIONS = `--require=${preload}`;
  }
  const launch = () => {
    collector = experimental_createBridgeDeltaEventCollector("vrata");
    eventRecords = []; messageCursor = 0; turnCursor = 0; requestId = undefined;
    const spec = experimental_resolveProviderBridgeLaunch({ modulePath: resolve("dist/host.js"), pluginId, cwd, dataDir });
    // Only the explicit lifecycle probe needs a direct onClose hook. Ordinary
    // integration and conformance always use the SDK worker above.
    const probe = `
      import { experimental_providerBridge as bridge } from ${JSON.stringify(new URL("../dist/host.js", import.meta.url).href)};
      bridge.start(${JSON.stringify({ pluginId, dataDir, tempDir: root })});
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const message = JSON.parse(line);
          if (message.method === "fixture/onClose") {
            bridge.onClose();
            process.stdout.write(JSON.stringify({ id: message.id, result: { closed: true } }) + "\\n");
          } else bridge.handleLine(line);
        }
      });
      process.stdin.on("end", () => bridge.onClose());
    `;
    transport = jsonlChild(spec.command, closeHook ? ["--input-type=module", "--eval", probe] : spec.args, { cwd: spec.cwd, env }); children.push(transport);
  };
  launch();
  const rpc = (method, params) => transport.request(method, params);
  const initialize = () => rpc("initialize", { client: { name: "native-fixture", version: "1" }, protocolVersion: 2 });
  await initialize();
  const deltas = (threadId = current?.threadId) => transport.messages.filter((m) => m.method === "thread/delta" && m.params.threadId === threadId).flatMap((m) => m.params.deltas);
  const records = (threadId = current?.threadId) => {
    while (messageCursor < transport.messages.length) {
      const logIndex = messageCursor++;
      const message = transport.messages[logIndex];
      // SDK assembly leaves identity unstamped; the notification owns routing.
      for (const event of collector.assembleMessage(message)) {
        if (event.type === "turn/completed") assert.equal(eventRecords.some((record) => record.event.type === "turn/completed" && record.threadId === message.params.threadId && record.event.scope.turnId === event.scope.turnId), false, "A turn must reach one terminal state");
        eventRecords.push({ event, logIndex, threadId: message.params.threadId });
      }
    }
    return eventRecords.filter((record) => record.threadId === threadId);
  };
  const events = (threadId) => records(threadId).map(({ event }) => event);
  const activeTurnId = () => {
    records();
    const bbTurnId = collector.assembler.getOpenTurnId(current.threadId);
    return bbTurnId ? collector.assembler.getProviderTurnId(current.threadId, bbTurnId) ?? bbTurnId : null;
  };
  const clientId = () => `creq_${(++counter).toString(16).replace(/0/g, "x").replace(/1/g, "y").padStart(10, "a")}`;
  const savedPath = (id = current.providerThreadId) => join(runtime.sessionDir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
  const readSession = (id) => {
    const path = savedPath(id);
    assert.ok(existsSync(path), `Session has not been persisted: ${path}`);
    return SessionManager.open(path);
  };
  return {
    root, cwd, dataDir, runtime, gateway, configure, rpc, deltas, events, records, clientId, savedPath,
    spawned() { return existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; },
    get current() { return current; }, get messages() { return transport.messages; }, get transport() { return transport; },
    saved(id) { return readSession(id).buildSessionContext(); },
    entries(id) { return readSession(id).getBranch(); },
    async anotherGateway(opts) { const result = await createGateway(opts); gateways.push(result); return result; },
    async start(extra = {}) {
      const { options: selected, ...rest } = extra;
      const params = { threadId: "thr_fixture", cwd, instructionMode: "append", ...rest, options: { ...options, ...selected } };
      const { result } = await rpc("thread/start", params);
      current = { threadId: params.threadId, providerThreadId: result.providerThreadId };
      turnCursor = events().length;
      return current;
    },
    async resume(providerThreadId, selected = { model: "vrata-setup", reasoningLevel: undefined }) {
      current = { threadId: `thr_resumed_${++counter}`, providerThreadId };
      const result = await rpc("thread/resume", { ...current, cwd, instructionMode: "append", options: { ...options, ...selected } });
      turnCursor = events().length;
      return result;
    },
    async turn(text, selected = {}) {
      turnCursor = events().length;
      requestId = clientId();
      return rpc("turn/start", { ...current, input: typeof text === "string" ? textInput(text) : text, clientRequestId: requestId, options: { ...options, ...selected } });
    },
    async steer(text, selected = {}, id = clientId()) {
      const expectedTurnId = activeTurnId();
      assert.ok(expectedTurnId, "Steer requires an actual active turn");
      await rpc("turn/steer", { ...current, expectedTurnId, input: textInput(text), clientRequestId: id, options: { ...options, ...selected } });
      return id;
    },
    stop(intent = "interrupt") { return rpc("thread/stop", { ...current, activeTurnId: intent === "release" ? null : activeTurnId(), intent }); },
    async boundary() {
      const expectedRequest = requestId, cursor = turnCursor;
      return until(() => {
        const recent = events().slice(cursor);
        const accepted = recent.find((event) => event.type === "turn/input/accepted" && event.clientRequestId === expectedRequest);
        if (!accepted) return undefined;
        const completed = recent.filter((event) => event.type === "turn/completed" && event.scope.turnId === accepted.scope.turnId);
        assert.ok(completed.length <= 1, "A request must reach one terminal state");
        return completed[0];
      }, `terminal event: ${transport.stderr}`, 30000);
    },
    reply(id, result) { transport.send(JSON.stringify({ jsonrpc: "2.0", id, result })); },
    replyError(id, message) { transport.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })); },
    toolCall() { return until(() => transport.messages.find((m) => m.method === "item/tool/call"), "dynamic tool call"); },
    interaction(kind) { return until(() => transport.messages.find((m) => m.method === "interaction/request" && m.params.payload.kind === kind), kind); },
    async restart() { await transport.close(); launch(); await initialize(); },
    async raw({ model = models.chat, thinking = "off", sessionFile = join(runtime.sessionDir, "raw.jsonl"), extraArgs = [] } = {}) {
      const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
      const referencePackage = JSON.parse(readFileSync(join(dirname(dirname(cli)), "..", "package.json"), "utf8"));
      assert.equal(referencePackage.version, "1.3.0", "Raw parity oracle must use pinned Pi 1.3.0");
      const { knownModelMetadata } = await import("../dist/tests/vrata.js");
      const extensionPath = join(root, "raw-guide.mjs");
      // Ordinary user guide registration: no candidate auth/redaction/stream wrapper.
      writeFileSync(extensionPath, `export default function(pi) { pi.registerProvider("vrata.tg", ${JSON.stringify({ baseUrl: gateway.url + "/v1", apiKey: "synthetic-key-a", models: knownModelMetadata(gateway.url) })}); }`);
      const child = jsonlChild(process.execPath, [cli, "--mode", "rpc", "--session", sessionFile, "--session-dir", runtime.sessionDir, "--extension", extensionPath, ...(model ? ["--model", model.includes("/") ? model : `vrata.tg/${model}`] : []), ...(thinking ? ["--thinking", thinking] : []), ...extraArgs], { cwd, env });
      children.push(child);
      await child.request("get_state", {}, true);
      let cursor = child.messages.length;
      return {
        child, sessionFile,
        rpc: (type, params = {}) => child.request(type, params, true),
        async prompt(text) { cursor = child.messages.length; return child.request("prompt", { message: text }, true); },
        async settled() { return until(() => child.messages.slice(cursor).find((m) => m.type === "agent_settled"), `raw agent settled: ${child.stderr}`, 30000); },
        saved: () => SessionManager.open(sessionFile).buildSessionContext(),
        entries: () => SessionManager.open(sessionFile).getBranch(),
      };
    },
  };
}
