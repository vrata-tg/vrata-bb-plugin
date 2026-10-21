import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { experimental_createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";

const images = [
  { name: "tiny.png", width: 1, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==" },
  { name: "wide.png", width: 2000, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAC7gAAAABCAYAAABO1+M+AAAAI0lEQVR4nO3BIQEAAAACIP+f1hsGIAUAAAAAAAAAAAAAgAMDCbKz02TBa4wAAAAASUVORK5CYII=" },
  { name: "tiny.gif", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
  { name: "tiny.webp", mimeType: "image/webp", data: "UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAEM1VICIC/Y+IBA==" },
  { name: "tiny.jpg", mimeType: "image/jpeg", data: "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6poA//9k=" },
];

async function nativeRuntimeProbe(t) {
  const { ensureEmbeddedPi } = await import("../dist/tests/embedded-pi.js");
  const root = mkdtempSync(join(tmpdir(), "vrata-native-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const results = await Promise.all(Array.from({ length: 4 }, () => ensureEmbeddedPi(join(root, "data"))));
  for (const runtime of results) assert.deepEqual(runtime, results[0]);
  assert.equal(readdirSync(join(root, "data/pi-runtime")).length, 1, "Atomic publish must leave only the completed capsule");
  assert.deepEqual(await ensureEmbeddedPi(join(root, "data")), results[0]);
  const { default: asset } = await import("../dist/tests/pi-runtime-asset.js");
  const bytes = Object.values(asset.files)[0];
  const original = bytes[0];
  try {
    bytes[0] ^= 1;
    await assert.rejects(ensureEmbeddedPi(join(root, "corrupt")), /checksum mismatch/);
    assert.equal(existsSync(join(root, "corrupt")), false, "A corrupt asset must not publish runtime files");
  } finally {
    bytes[0] = original;
  }
  const runtime = results[0];
  const { SessionManager } = await import(pathToFileURL(runtime.sdkEntry).href);
  const session = SessionManager.inMemory(root);
  session.appendMessage({ role: "user", content: "native migration proof", timestamp: 1 });
  session.appendModelChange("packaging-test", "synthetic");
  session.appendThinkingLevelChange("low");
  const context = session.buildSessionContext();
  assert.equal(context.messages[0].content, "native migration proof");
  assert.equal(context.model.modelId, "synthetic");
  assert.equal(context.thinkingLevel, "low");

  mkdirSync(join(root, "bin"));
  symlinkSync("/bin/bash", join(root, "bin/bash"));
  writeFileSync(join(root, "wide.png"), Buffer.from(images[1].data, "base64"));
  writeFileSync(join(root, "provider.ts"), String.raw`
import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  if (typeof SessionManager.create !== "function" || Type.String().type !== "string") throw Error("Virtual modules unavailable");
  let calls = 0;
  pi.registerProvider("packaging-test", {
    baseUrl: "http://127.0.0.1:1", apiKey: "synthetic-unused", api: "packaging-test-api",
    models: [{ id: "synthetic", name: "Packaging proof", reasoning: false, input: ["text", "image"],
      contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      writeFileSync(process.env.PACKAGING_TRACE, JSON.stringify(context));
      const content = ++calls === 1 ? [
        { type: "toolCall", id: "read-image", name: "read", arguments: { path: "wide.png" } },
        { type: "toolCall", id: "write-file", name: "write", arguments: { path: "proof.txt", content: "native write" } },
        { type: "toolCall", id: "run-bash", name: "bash", arguments: { command: "printf native-bash" } },
        { type: "toolCall", id: "codemode", name: "codemode", arguments: { code: "text(6 * 7)" } },
      ] : [{ type: "text", text: "Complete" }];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        stopReason: calls === 1 ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
}
`);
  const child = spawn(process.execPath, ["--no-global-search-paths", runtime.rpcEntry,
    "--extension", join(root, "provider.ts"), "--provider", "packaging-test", "--model", "synthetic",
    "--tools", "read,write,bash,codemode", "--session-dir", join(root, "sessions")], {
    cwd: root, env: { PATH: join(root, "bin"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_TELEMETRY: "off",
      PACKAGING_TRACE: join(root, "trace.json") }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "exit");
  const events = [];
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => events.push(JSON.parse(line)));
  async function until(predicate) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = predicate();
      if (value) return value;
      assert.equal(child.exitCode, null, stderr);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Native RPC timed out: ${stderr}`);
  }
  async function rpc(type, params = {}) {
    child.stdin.write(JSON.stringify({ id: type, type, ...params }) + "\n");
    const response = await until(() => events.find((event) => event.type === "response" && event.id === type));
    assert.ok(response.success, JSON.stringify(response));
    return response.data;
  }
  try {
    assert.equal((await rpc("get_state")).model.provider, "packaging-test");
    await rpc("prompt", { message: "Run synthetic packaging proof" });
    await until(() => events.some((event) => event.type === "agent_end"));
    const tools = events.filter((event) => event.type === "tool_execution_end");
    assert.equal(tools.length, 4);
    assert.deepEqual(tools.filter((event) => event.isError), []);
    assert.equal(readFileSync(join(root, "proof.txt"), "utf8"), "native write");
    assert.match(JSON.stringify(tools.find((event) => event.toolName === "bash").result), /native-bash/);
    assert.match(JSON.stringify(tools.find((event) => event.toolName === "codemode").result), /42/);
    const trace = JSON.parse(readFileSync(join(root, "trace.json"), "utf8"));
    const image = trace.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => part.type === "image");
    assert.ok(image, "Native read must retain the resized image");
    assert.equal(Buffer.from(image.data, "base64").readUInt32BE(16), 2000);
    await rpc("export_html", { outputPath: join(root, "session.html") });
    assert.match(readFileSync(join(root, "session.html"), "utf8"), /<!DOCTYPE html>/i);
    assert.equal(stderr, "");
  } finally {
    child.kill();
    await closed;
    lines.close();
  }
}

async function probe(cleanup) {
  const root = mkdtempSync(join(tmpdir(), "vrata-packaged-host-"));
  const previousCwd = process.cwd();
  const hostFile = new URL("../dist/host.js", import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("../dist/host.meta.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(hostFile)).digest("hex"), metadata.artifactDigest);
  copyFileSync(hostFile, join(root, "host.mjs"));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "bin"));
  symlinkSync("/bin/bash", join(root, "bin/bash"));
  process.env.PATH = join(root, "bin");
  process.env.PI_TELEMETRY = "off";
  for (const fixture of images) writeFileSync(join(root, fixture.name), Buffer.from(fixture.data, "base64"));
  cleanup.push(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });

  const requests = [];
  let fixture;
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
        id: "gemini-3.8-flash",
        gateway_metadata: { supports_tools: true, supports_images: true, verified_transport: "chat_completions" },
      }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolCall = requests.length % 2 === 1;
    const delta = toolCall ? { role: "assistant", tool_calls: [{
      index: 0, id: `read-${requests.length}`, type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: fixture.name }) },
    }] } : { role: "assistant", content: "Image received" };
    const chunk = (value, finish_reason) => `data: ${JSON.stringify({
      id: `completion-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: "gemini-3.8-flash", choices: [{ index: 0, delta: value, finish_reason }],
    })}\n\n`;
    response.write(chunk(delta, null));
    response.write(chunk({}, toolCall ? "tool_calls" : "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  writeFileSync(join(root, "data", "credentials.json"), JSON.stringify({
    apiKey: "synthetic-key", baseUrl: `http://127.0.0.1:${server.address().port}`,
  }), { mode: 0o600 });

  // Both the module's resolution root and cwd are outside the checkout. Only
  // host.mjs is copied: no WASM, resize worker, or node_modules accompanies it.
  process.chdir(root);
  const { experimental_providerBridge: bridge } = await import(pathToFileURL(join(root, "host.mjs")).href);
  await bridge.start({ pluginId: "vrata", dataDir: join(root, "data"), tempDir: join(root, "temp") });
  const harness = experimental_createBridgeJsonRpcTestHarness(bridge.handleLine);
  cleanup.push(async () => {
    harness.restore();
    await bridge.onClose?.();
  });
  let nextId = 0;
  async function request(method, params) {
    const id = `packaging-${++nextId}`;
    harness.sendRequest(id, method, params);
    const reply = await harness.waitForResponse(id);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  }
  await request("initialize", { client: { name: "packaging-test", version: "1" }, protocolVersion: 2 });
  for (fixture of images) {
    const threadId = `thr_packaging_${fixture.name.replace(".", "_")}`;
    const started = await request("thread/start", {
      threadId, cwd: root, instructionMode: "append",
      options: { model: "gemini-3.8-flash", reasoningLevel: "none", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null },
    });
    await request("turn/start", { threadId, providerThreadId: started.providerThreadId,
      clientRequestId: `creq_222222222${images.indexOf(fixture) + 2}`,
      input: [{ type: "text", text: `Read ${fixture.name}`, mentions: [] }],
      options: { model: "gemini-3.8-flash", reasoningLevel: "none", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null },
    });
    let boundary;
    for (let attempt = 0; attempt < 750; attempt++) {
      boundary = harness.messages.filter((message) => message.method === "thread/delta" && message.params.threadId === threadId)
        .flatMap((message) => message.params.deltas).find((delta) => delta.kind === "turn.boundary");
      if (boundary) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(boundary?.status, "completed");
    const content = requests.at(-1).messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const image = content.find((part) => part.type === "image_url");
    assert.ok(image, "Pi's read result must retain the processed image");
    assert.ok(image.image_url.url.startsWith(`data:${fixture.mimeType};base64,`));
    const bytes = Buffer.from(image.image_url.url.split(",")[1], "base64");
    if (fixture.width) assert.equal(bytes.readUInt32BE(16), fixture.width, "Pi must resize the 3000px fixture to its 2000px limit");
    if (fixture.name !== "wide.png") {
      assert.equal(bytes.toString("base64"), fixture.data, "Small images retain their format and bytes");
    }
    await request("thread/stop", { threadId, providerThreadId: started.providerThreadId, activeTurnId: null, intent: "release" });
  }
  assert.equal(requests.length, images.length * 2);
}

if (process.argv[2] === "--probe") {
  const cleanup = [];
  try {
    await probe(cleanup);
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
  }
} else {
  const { default: test } = await import("node:test");
  test("embedded Pi publishes atomically and runs stock RPC tools outside the checkout", nativeRuntimeProbe);
  test("standalone BB host reads PNG/JPEG/GIF/WebP and resizes PNG without sidecar assets", async () => {
    // SDK's harness owns stdout. Keep the test runner's TAP/IPC outside its process.
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--probe"], { env, timeout: 60000 });
  });
}
