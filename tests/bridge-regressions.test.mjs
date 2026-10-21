import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { answer, callTool, chunk, dynamicTool, finish, fixture, models, options, png, sleep, until } from "./bridge-fixture.mjs";

for (const intent of ["interrupt", "release"]) {
  test(`${intent} closes native generation and rejects late stream work`, async (t) => {
    let held;
    const f = await fixture(t, { onChat({ response, index }) {
      if (index === 0) { held = response; chunk(response, { role: "assistant", content: "Persisted partial response" }); }
      else answer(response);
    } });
    const { providerThreadId } = await f.start();
    await f.turn("First input is retained");
    await until(() => f.deltas().some((d) => JSON.stringify(d).includes("Persisted partial")), "partial text");
    const before = f.messages.length;
    const stopped = await f.stop(intent);
    if (intent === "interrupt") {
      const endIndex = f.messages.findIndex((m) => m.method === "thread/delta" && m.params.deltas.some((d) => d.kind === "session.ended"));
      assert.ok(endIndex >= 0 && endIndex < f.messages.findIndex((m) => m.id === stopped.id));
    } else assert.equal(f.messages.slice(before).some((m) => m.method === "thread/delta"), false, "release fabricates no lifecycle events");
    const snapshot = readFileSync(f.savedPath(), "utf8"), eventCount = f.messages.length;
    callTool(held, dynamicTool.name);
    await sleep(100);
    assert.equal(f.gateway.requests.length, 1);
    assert.equal(f.messages.length, eventCount);
    assert.equal(readFileSync(f.savedPath(), "utf8"), snapshot);
    assert.match(JSON.stringify(f.saved().messages), /First input is retained/);
    assert.match(JSON.stringify(f.saved().messages), /Persisted partial response/);
    await f.resume(providerThreadId);
    await f.turn("Continue after stop", { model: "vrata-setup", reasoningLevel: undefined });
    assert.equal((await f.boundary()).status, "completed");
    assert.match(JSON.stringify(f.gateway.requests[1].body.messages), /First input is retained/);
  });
}

test("Stop during a reasoning rebuild closes both Pi children and lets the host exit", async (t) => {
  const f = await fixture(t, {}, { settings: { defaultProjectTrust: "always" } });
  const marker = join(f.root, "session-pids.jsonl"), gate = join(f.root, "hold-startup");
  const extensionDir = join(f.cwd, ".pi/extensions");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "hold-startup.js"), `
    import { appendFileSync, existsSync } from "node:fs";
    export default function(pi) {
      pi.on("session_start", async () => {
        appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.pid) + "\\n");
        while (existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));
      });
    }
  `);
  const pids = () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  try {
    await f.start(); await f.turn("Persist before rebuilding"); await f.boundary();
    assert.equal(pids().length, 1);
    writeFileSync(gate, "hold replacement startup");
    const rebuilding = f.turn("Never dispatch this input", { reasoningLevel: "high" })
      .then(() => ({ accepted: true }), (error) => ({ error }));
    await until(() => pids().length === 2, "replacement entered its startup hook");
    const both = pids();
    assert.ok(both.every(alive), "the old and replacement sessions are both running");
    await f.stop();
    assert.ok((await rebuilding).error, "cancelled replacement rejects the queued turn");
    await until(() => both.every((pid) => !alive(pid)), "both Pi sessions exit after Stop", 12000);
    assert.equal(f.gateway.requests.length, 1, "no generation follows cancellation");
    assert.match(JSON.stringify(f.saved().messages), /Persist before rebuilding/);
    f.transport.child.stdin.end();
    await until(() => f.transport.child.exitCode !== null, "host exits without forced termination", 12000);
    assert.equal(f.transport.child.exitCode, 0);
  } finally {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("configuration switches endpoint and credential together on an existing session", async (t) => {
  const f = await fixture(t);
  const second = await f.anotherGateway();
  await f.start(); await f.turn("Account A"); await f.boundary();
  f.configure(second, "synthetic-key-b");
  await f.turn("Account B"); assert.equal((await f.boundary()).status, "completed");
  assert.equal(f.gateway.requests.length, 1);
  assert.equal(f.gateway.requests[0].authorization, "Bearer synthetic-key-a");
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].authorization, "Bearer synthetic-key-b");
});

test("per-turn model and reasoning survive bridge process restart", async (t) => {
  const f = await fixture(t);
  const { providerThreadId } = await f.start();
  await f.turn("First model"); await f.boundary();
  await f.turn("Explicit model change", { model: models.responses, reasoningLevel: "high" });
  assert.equal((await f.boundary()).status, "completed");
  assert.equal(f.gateway.requests[1].path, "/v1/responses");
  assert.equal(f.gateway.requests[1].body.reasoning.effort, "high");
  await f.restart();
  await f.resume(providerThreadId);
  await f.turn("Restored selection", { model: "vrata-setup", reasoningLevel: undefined });
  assert.equal((await f.boundary()).status, "completed");
  assert.equal(f.gateway.requests[2].body.model, models.responses);
  assert.equal(f.gateway.requests[2].body.reasoning.effort, "high");
  assert.match(JSON.stringify(f.gateway.requests[2].body.input), /Explicit model change/);
  assert.equal(f.saved().model.modelId, models.responses);
  assert.equal(f.saved().thinkingLevel, "high");
});

test("steer is consumed by native Pi and acknowledged with its client request ID", async (t) => {
  let held;
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) { held = response; chunk(response, { role: "assistant", content: "First part" }); }
    else answer(response, "Steered answer");
  } });
  await f.start(); await f.turn("Initial input");
  await until(() => held, "held generation");
  const id = await f.steer("Consumed steer marker");
  finish(held);
  await until(() => f.gateway.requests.length === 2, "steered request");
  await f.boundary();
  assert.ok(f.deltas().some((d) => d.kind === "input.accepted" && d.clientRequestId === id));
  assert.match(JSON.stringify(f.gateway.requests[1].body.messages), /Consumed steer marker/);
  await until(() => JSON.stringify(f.saved().messages).includes("Steered answer"), "steered history persisted");
});

for (const kind of ["success", "failure", "RPC error"]) {
  test(`dynamic ${kind} preserves native recovery and ordered rich results`, async (t) => {
    const f = await fixture(t, { onChat({ response, index }) { if (!index) callTool(response); else answer(response, "Tool recovered"); } });
    await f.start({ dynamicTools: [dynamicTool] }); await f.turn("Run the tool");
    const call = await f.toolCall();
    assert.equal(call.params.tool, dynamicTool.name);
    assert.deepEqual(call.params.arguments, { value: "fixture" });
    const content = [{ type: "text", text: "Before image" }, { type: "image", mimeType: "image/png", data: png }, { type: "text", text: "After image" }];
    if (kind === "RPC error") f.replyError(call.id, "Synthetic RPC failure");
    else f.reply(call.id, { success: kind === "success", contentItems: [{ type: "inputText", text: content[0].text }, { type: "inputImage", imageUrl: `data:image/png;base64,${png}` }, { type: "inputText", text: content[2].text }] });
    assert.equal((await f.boundary()).status, "completed");
    const saved = f.saved().messages.find((m) => m.role === "toolResult");
    assert.equal(saved.isError, kind !== "success");
    const close = f.deltas().find((d) => d.kind === "item.close" && d.item?.type === "tool");
    assert.equal(close.status, kind === "success" ? "completed" : "failed");
    assert.equal(f.gateway.requests.length, 2);
    if (kind !== "RPC error") {
      assert.deepEqual(saved.content, content);
      assert.ok(close.resultText.indexOf("Before image") < close.resultText.indexOf("After image"));
      const messages = f.gateway.requests[1].body.messages;
      const index = messages.findIndex((m) => m.role === "tool");
      assert.equal(messages[index].content, "Before image\nAfter image");
      assert.ok(JSON.stringify(messages[index + 1]).includes(png));
    } else assert.match(JSON.stringify(saved), /Synthetic RPC failure/);
  });
}

test("pending dynamic tool rejects late replies after native Stop", async (t) => {
  const f = await fixture(t, { onChat({ response }) { callTool(response); } });
  await f.start({ dynamicTools: [dynamicTool] }); await f.turn("Wait for tool");
  const call = await f.toolCall();
  await f.stop();
  const count = f.messages.length, snapshot = readFileSync(f.savedPath(), "utf8");
  f.reply(call.id, { success: true, contentItems: [{ type: "inputText", text: "LATE_RESULT" }] });
  await sleep(100);
  assert.equal(f.messages.length, count);
  assert.equal(f.gateway.requests.length, 1);
  assert.equal(readFileSync(f.savedPath(), "utf8"), snapshot);
  assert.doesNotMatch(snapshot, /LATE_RESULT/);
});

test("disallowed stock and dynamic tools are absent and cannot execute", async (t) => {
  let forbiddenPath;
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) callTool(response, "bash", { command: `touch '${forbiddenPath}'` });
    else if (index === 1) callTool(response);
    else answer(response);
  } });
  forbiddenPath = join(f.cwd, "forbidden");
  await f.start({ dynamicTools: [dynamicTool], disallowedTools: ["bash", dynamicTool.name] });
  await f.turn("Excluded tools"); assert.equal((await f.boundary()).status, "completed");
  const names = f.gateway.requests[0].body.tools.map((tool) => tool.function.name);
  assert.ok(names.includes("read"));
  assert.ok(!names.includes("bash") && !names.includes(dynamicTool.name));
  assert.equal(existsSync(forbiddenPath), false);
  assert.equal(f.messages.some((m) => m.method === "item/tool/call"), false);
  assert.ok(f.saved().messages.filter((m) => m.role === "toolResult").every((m) => m.isError));
});

test("upstream HTTP401 keeps native diagnostics while redacting credentials everywhere", async (t) => {
  const marker = "LEAK123 synthetic-private-key";
  const f = await fixture(t, { onChat({ response }) { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: marker } })); } });
  f.configure(f.gateway, "synthetic-private-key");
  await f.start(); await f.turn("Unauthorized fixture");
  assert.equal((await f.boundary()).status, "failed");
  const output = JSON.stringify(f.messages) + f.transport.stderr + readFileSync(f.savedPath(), "utf8");
  assert.doesNotMatch(output, /synthetic-private-key/);
  assert.match(output, /401|auth|ключ/i);
});

test("legacy snapshot resumes through native Pi and reaches the next model request", async (t) => {
  const f = await fixture(t);
  const id = randomUUID(), legacyDir = join(f.dataDir, "sessions"); mkdirSync(legacyDir);
  const source = JSON.stringify({ messages: [{ role: "user", content: "Legacy history marker", timestamp: 1 }], selectedModelId: models.responses, selectedReasoningLevel: "high" });
  writeFileSync(join(legacyDir, `${id}.json`), source);
  await f.resume(id);
  await f.turn("After migration", { model: "vrata-setup", reasoningLevel: undefined });
  assert.equal((await f.boundary()).status, "completed");
  const request = f.gateway.requests[0];
  assert.equal(request.path, "/v1/responses");
  assert.equal(request.body.model, models.responses);
  assert.equal(request.body.reasoning.effort, "high");
  assert.match(JSON.stringify(request.body.input), /Legacy history marker/);
  assert.equal(readFileSync(join(legacyDir, `${id}.json`), "utf8"), source);
});

test("concurrent same-thread replacement leaves no generation after Stop", async (t) => {
  const held = [];
  const f = await fixture(t, { onChat({ response }) { held.push(response); chunk(response, { role: "assistant", content: "Held" }); } });
  const starts = await Promise.allSettled([f.start(), f.start()]);
  assert.equal(starts[1].status, "fulfilled", "Latest start owns the session");
  if (starts[0].status === "rejected") assert.match(String(starts[0].reason), /abort|stopped|останов/i);
  await f.turn("Only the current generation");
  await until(() => held.length > 0, "current generation");
  await f.stop();
  const count = f.messages.length, requests = f.gateway.requests.length;
  for (const response of held) callTool(response);
  await sleep(100);
  assert.equal(f.gateway.requests.length, requests);
  assert.equal(f.messages.length, count);
  assert.equal(f.messages.some((m) => m.method === "item/tool/call"), false);
});

test("explicit onClose rejects pending setup replies and new RPCs in the same live process", async (t) => {
  const f = await fixture(t, {}, { configured: false, closeHook: true });
  await f.start({ options: { model: "vrata-setup" } });
  await f.turn("Pending close input", { model: "vrata-setup" });
  const key = await f.interaction("vrata/api-key");
  await f.rpc("fixture/onClose", {});
  const count = f.messages.length;
  f.configure();
  f.reply(key.id, { kind: "request_answer", value: { configured: true } });
  for (const [method, params] of [
    ["initialize", { client: { name: "late", version: "1" }, protocolVersion: 2 }],
    ["model/list", { cwd: f.cwd }],
    ["thread/start", { threadId: "thr_late", cwd: f.cwd, instructionMode: "append", options }],
  ]) f.transport.send(JSON.stringify({ jsonrpc: "2.0", id: `late-${method}`, method, params }));
  // Unlike closing stdin, the test process is alive and receives all late RPCs.
  await sleep(1000);
  assert.equal(f.transport.child.exitCode, null);
  assert.equal(f.messages.length, count);
  assert.equal(f.gateway.requests.length, 0);
  assert.equal(existsSync(f.savedPath()), false);
});

test("BB configured skills are loaded and expanded by native Pi", async (t) => {
  const f = await fixture(t);
  const skills = join(f.root, "bb-skills"), directory = join(skills, "fixture"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "---\nname: fixture\ndescription: BB_SKILL_DISCOVERY_782\n---\nBB_SKILL_BODY_782\n");
  await f.rpc("skills/configure", { roots: [{ id: "fixture-root", path: skills, skills: [{ name: "fixture", description: "BB_SKILL_DISCOVERY_782" }] }] });
  await f.start(); await f.turn("/skill:fixture");
  assert.equal((await f.boundary()).status, "completed");
  const request = JSON.stringify(f.gateway.requests[0].body.messages);
  assert.match(request, /BB_SKILL_DISCOVERY_782/);
  assert.match(request, /BB_SKILL_BODY_782/);
});
