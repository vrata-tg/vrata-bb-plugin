import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { VRATA_EXTENSION_SOURCE, VRATA_PI_SETTINGS } from "../dist/tests/vrata-extension.js";
import { knownModelMetadata } from "../dist/tests/vrata.js";
import { buildUserAgent } from "../dist/tests/user-agent.js";
import { createGateway, answer, chunk, finish, models } from "./bridge-fixture.mjs";

async function nativeSession(t, config, model = models.chat, thinkingLevel = "off") {
  const dir = mkdtempSync(join(tmpdir(), "vrata-extension-"));
  const credentials = join(dir, "credentials.json"), extension = join(dir, "vrata.mjs");
  const previous = process.env.VRATA_CREDENTIALS_PATH, previousCatalog = process.env.VRATA_MODEL_CATALOG;
  const previousUserAgent = process.env.VRATA_USER_AGENT;
  process.env.VRATA_USER_AGENT = buildUserAgent({ distribution: "vrata-bb-plugin", bbVersion: "0.41.0" });
  process.env.VRATA_CREDENTIALS_PATH = credentials;
  process.env.VRATA_MODEL_CATALOG = JSON.stringify(knownModelMetadata(config.baseUrl));
  const configure = (value) => {
    writeFileSync(credentials + ".next", JSON.stringify(value), { mode: 0o600 });
    renameSync(credentials + ".next", credentials);
  };
  configure(config);
  writeFileSync(extension, VRATA_EXTENSION_SOURCE);
  let session;
  t.after(async () => {
    await session?.abort();
    session?.dispose();
    if (previous === undefined) delete process.env.VRATA_CREDENTIALS_PATH;
    else process.env.VRATA_CREDENTIALS_PATH = previous;
    if (previousCatalog === undefined) delete process.env.VRATA_MODEL_CATALOG;
    else process.env.VRATA_MODEL_CATALOG = previousCatalog;
    if (previousUserAgent === undefined) delete process.env.VRATA_USER_AGENT;
    else process.env.VRATA_USER_AGENT = previousUserAgent;
    rmSync(dir, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory({
    ...structuredClone(VRATA_PI_SETTINGS),
    compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 64 },
  });
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager,
    resourceLoaderOptions: { additionalExtensionPaths: [extension], noExtensions: true,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true },
  });
  assert.ok(!services.diagnostics.some((d) => d.type === "error"), "standalone extension failed to load");
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: services.modelRuntime.getModel("vrata.tg", model), thinkingLevel }));
  const errors = [], events = [];
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
  await services.modelRuntime.refresh({ allowNetwork: false });
  assert.equal(errors.length, 0, "extension startup hook failed");
  session.subscribe((event) => events.push(structuredClone(event)));
  return { session, events, manager, configure,
    serialized: () => JSON.stringify(events) + readFileSync(manager.getSessionFile(), "utf8"),
  };
}

async function gateway(t, handlers) {
  const result = await createGateway(handlers);
  t.after(() => result.close());
  return result;
}

for (const [kind, path] of [["chat", "/v1/chat/completions"], ["responses", "/v1/responses"], ["anthropic", "/v1/messages"]]) {
  test(`native ${kind} dispatch preserves opaque credentials and guide API`, { timeout: 20000 }, async (t) => {
    const server = await gateway(t);
    const key = kind === "responses" ? "$NOT_AN_ENV_LOOKUP" : "!opaque-command-$NOT_EXPANDED";
    const { session } = await nativeSession(t, { apiKey: key, baseUrl: server.url }, models[kind], "high");
    await session.prompt("fixture transport check");
    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.userAgent, process.env.VRATA_USER_AGENT);
    assert.equal(request.path, path);
    assert.ok(request.apiKey === key || request.authorization === `Bearer ${key}`, "credential was not sent opaquely");
    assert.ok(JSON.stringify(request.body).includes("fixture transport check"), "native request omitted prompt");
    const effort = kind === "anthropic" ? request.body.output_config?.effort
      : kind === "responses" ? request.body.reasoning?.effort : request.body.reasoning_effort;
    assert.equal(effort, "high", "native transport lost reasoning selection");
    assert.equal(session.messages.at(-1).stopReason, "stop");
    assert.equal(session.messages.at(-1).content.find((part) => part.type === "text")?.text, "Loopback answer");
    const [inputPrice, outputPrice] = kind === "anthropic" ? [10, 51] : kind === "responses" ? [12, 60] : [6, 26];
    assert.equal(session.messages.at(-1).usage.cost.input, inputPrice / 1_000_000 * 10);
    assert.equal(session.messages.at(-1).usage.cost.output, outputPrice / 1_000_000 * 4);
  });
}

test("native retry keeps the active key+URL snapshot and redacts secrets before events/history", { timeout: 25000 }, async (t) => {
  const keyA = "!synthetic-key-a-$OPAQUE", keyB = "$synthetic-key-b";
  const serverB = await gateway(t);
  let native;
  const serverA = await gateway(t, { onChat: ({ response, index }) => {
    if (index === 0) {
      native.configure({ apiKey: keyB, baseUrl: serverB.url });
      response.writeHead(503, { "content-type": "application/json", "x-fixture-secret": keyA })
        .end(JSON.stringify({ error: { type: "server_error", message: `ordinary upstream detail ${keyA}` } }));
    } else answer(response);
  } });
  native = await nativeSession(t, { apiKey: keyA, baseUrl: serverA.url });
  await native.session.prompt("retry fixture");
  assert.equal(serverA.requests.length, 2, "native automatic retry did not run exactly once");
  assert.ok(serverA.requests.every((r) => r.userAgent === process.env.VRATA_USER_AGENT));
  assert.equal(serverB.requests.length, 0, "in-flight operation changed endpoint");
  assert.ok(serverA.requests.every((r) => r.authorization === `Bearer ${keyA}`), "retry changed credential snapshot");
  assert.ok(native.events.some((event) => event.type === "auto_retry_start"), "native retry event missing");
  const serialized = native.serialized();
  assert.ok(!serialized.includes(keyA) && !serialized.includes(keyB), "credential escaped into diagnostics or native JSONL");
  assert.ok(serialized.includes("ordinary upstream detail") && serialized.includes("503"), "redaction changed native error classification/details");
  await native.session.prompt("next operation fixture");
  assert.equal(serverB.requests.length, 1, "next operation did not refresh endpoint");
  assert.ok(serverB.requests[0].authorization === `Bearer ${keyB}`, "next operation reused cached auth");
});

test("queued steer retains its operation snapshot; abort settles a pending native request", { timeout: 25000 }, async (t) => {
  const keyA = "synthetic-steer-key-a", keyB = "synthetic-steer-key-b";
  const received = Promise.withResolvers(), release = Promise.withResolvers(), pendingRequest = Promise.withResolvers();
  const serverB = await gateway(t, { onChat: () => pendingRequest.resolve() });
  const serverA = await gateway(t, { onChat: async ({ response, index }) => {
    if (index === 0) { received.resolve(); await release.promise; }
    answer(response);
  } });
  const native = await nativeSession(t, { apiKey: keyA, baseUrl: serverA.url });
  const first = native.session.prompt("queued fixture");
  await received.promise;
  native.configure({ apiKey: keyB, baseUrl: serverB.url });
  await native.session.steer("queued steer fixture");
  release.resolve();
  await first;
  assert.equal(serverA.requests.length, 2, "queued steer did not continue the native operation");
  assert.ok(serverA.requests.every((r) => r.authorization === `Bearer ${keyA}`), "queued continuation changed key");
  assert.equal(serverB.requests.length, 0, "queued continuation changed endpoint");
  assert.ok(JSON.stringify(serverA.requests[1].body).includes("queued steer fixture"), "steer content missing");
  const pending = native.session.prompt("abort fixture");
  await pendingRequest.promise;
  await native.session.abort();
  await pending;
  assert.equal(native.session.messages.at(-1).stopReason, "aborted");
  assert.equal(serverB.requests.length, 1, "aborted operation retried");
  assert.ok(native.events.some((event) => event.type === "agent_settled" && event.aborted), "native abort never settled");
});

test("manual native compaction retries with redacted diagnostics and persists its summary", { timeout: 25000 }, async (t) => {
  const key = "synthetic-compaction-key";
  const server = await gateway(t, { onChat: ({ response, index }) => {
    if (index === 2) response.writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: `summary retry detail ${key}` } }));
    else answer(response, index > 2 ? "Native summary fixture" : "Loopback answer");
  } });
  const native = await nativeSession(t, { apiKey: key, baseUrl: server.url });
  await native.session.prompt("compaction input ".repeat(200));
  await native.session.prompt("recent input ".repeat(100));
  const result = await native.session.compact();
  assert.equal(result.summary, "Native summary fixture");
  assert.equal(server.requests.length, 4, "native compaction retry count changed");
  assert.ok(server.requests.every((r) => r.userAgent === process.env.VRATA_USER_AGENT));
  assert.ok(native.events.some((event) => event.type === "summarization_retry_scheduled"), "native summary retry event missing");
  assert.ok(native.manager.getEntries().some((entry) => entry.type === "compaction" && entry.summary === result.summary));
  const serialized = native.serialized();
  assert.ok(!serialized.includes(key), "summary diagnostics leaked a credential");
  assert.ok(serialized.includes("summary retry detail"), "summary diagnostic content was replaced");
});

test("invalid rotated credentials close the stream without another generation request", { timeout: 10000 }, async (t) => {
  const key = "synthetic-invalid-rotation";
  const server = await gateway(t);
  const native = await nativeSession(t, { apiKey: key, baseUrl: server.url });
  await native.session.prompt("initial fixture");
  native.configure({ apiKey: key, baseUrl: "invalid url with secret fixture" });
  await native.session.prompt("invalid rotation fixture");
  assert.equal(server.requests.length, 1, "invalid config dispatched generation");
  assert.equal(native.session.messages.at(-1).stopReason, "error");
  assert.equal(native.session.messages.at(-1).errorMessage, "Provider is not configured: vrata.tg");
  assert.ok(!native.serialized().includes(key), "invalid credentials error exposed a key");
  native.configure({ apiKey: key, baseUrl: server.url });
  await native.session.prompt("restored credentials fixture");
  assert.equal(server.requests.length, 2, "valid credentials did not restore native auth");
  assert.equal(native.session.messages.at(-1).stopReason, "stop");
});

test("full and split credential echoes are removed without changing ordinary streamed text", { timeout: 10000 }, async (t) => {
  const key = "synthetic-upstream-echo-key";
  const parts = ["ordinary answer ", key, " / ", key.slice(0, 5), key.slice(5, 13), key.slice(13), " trailing syn"];
  const expected = "ordinary answer [redacted] / [redacted] trailing syn";
  const server = await gateway(t, { onChat: ({ response }) => {
    for (const content of parts) chunk(response, { content });
    finish(response);
  } });
  const native = await nativeSession(t, { apiKey: key, baseUrl: server.url });
  await native.session.prompt("credential echo fixture");
  const serialized = native.serialized();
  assert.ok(!serialized.includes(key), "upstream echo reached native events or JSONL");
  const deltaText = native.events.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
    .map((e) => e.assistantMessageEvent.delta).join("");
  assert.ok(deltaText === expected, "aggregated deltas leaked a split key or changed ordinary text");
  const resultText = native.session.messages.at(-1).content.find((part) => part.type === "text")?.text;
  assert.ok(resultText === expected, "terminal content differs from safe deltas");
  const saved = native.manager.getEntries().filter((entry) => entry.type === "message").at(-1).message;
  assert.ok(saved.content.find((part) => part.type === "text")?.text === expected, "persisted text differs from safe deltas");
});
