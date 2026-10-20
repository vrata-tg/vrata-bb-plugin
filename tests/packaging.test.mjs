import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
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

async function probe(cleanup) {
  const root = mkdtempSync(join(tmpdir(), "vrata-packaged-host-"));
  const previousCwd = process.cwd();
  const hostFile = new URL("../dist/host.js", import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("../dist/host.meta.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(readFileSync(hostFile)).digest("hex"), metadata.artifactDigest);
  copyFileSync(hostFile, join(root, "host.mjs"));
  mkdirSync(join(root, "data"));
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
        id: "packaging-model",
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
      model: "packaging-model", choices: [{ index: 0, delta: value, finish_reason }],
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
  bridge.start({ pluginId: "vrata", dataDir: join(root, "data"), tempDir: join(root, "temp") });
  const harness = experimental_createBridgeJsonRpcTestHarness(bridge.handleLine);
  cleanup.push(() => {
    harness.restore();
    bridge.onClose?.();
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
      options: { model: "packaging-model", reasoningLevel: "none", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null },
      input: [{ type: "text", text: `Read ${fixture.name}`, mentions: [] }],
    });
    let boundary;
    for (let attempt = 0; attempt < 200; attempt++) {
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
    if (fixture.name === "wide.png") {
      assert.ok(JSON.stringify(requests.at(-1).messages).includes("3000x1"), "Read result must preserve original dimensions");
    } else {
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
  const { createImageReadTool } = await import("../dist/tests/image-runtime.js");
  test("image read rejects corrupt images and preserves cancellation", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "vrata-image-read-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "corrupt.png"), Buffer.from(images[0].data, "base64").subarray(0, 33));
    writeFileSync(join(root, "valid.png"), Buffer.from(images[0].data, "base64"));
    const read = createImageReadTool(root);
    await assert.rejects(read.execute("corrupt", { path: "corrupt.png" }), /Не удалось обработать изображение/);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(read.execute("cancelled", { path: "missing.png" }, cancelled.signal), { name: "AbortError" });
    const pending = new AbortController();
    const result = read.execute("pending", { path: "valid.png" }, pending.signal);
    pending.abort();
    await assert.rejects(result, /abort/i);
  });
  test("standalone BB host reads PNG/JPEG/GIF/WebP and resizes PNG without sidecar assets", async () => {
    // SDK's harness owns stdout. Keep the test runner's TAP/IPC outside its process.
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--probe"], { env, timeout: 20000 });
  });
}
