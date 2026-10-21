import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { answer, callTool, chunk, dynamicTool, finish, fixture, models, options, sleep, until } from "./bridge-fixture.mjs";

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
      const end = f.records().find(({ event }) => event.type === "turn/completed" && event.status === "interrupted");
      assert.ok(end && end.logIndex < f.messages.findIndex((m) => m.id === stopped.id));
    } else assert.equal(f.records().some(({ event, logIndex }) => logIndex >= before && (event.type === "system/thread/interrupted" || (event.type === "turn/completed" && event.status === "interrupted"))), false, "release fabricates no interruption");
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

test("Stop during a held native model setter releases its child before acknowledging", async (t) => {
  const f = await fixture(t, {}, { settings: { defaultProjectTrust: "always" }, traceChildren: true });
  const marker = join(f.root, "setter-entered"), gate = join(f.root, "hold-setter");
  const extensionDir = join(f.cwd, ".pi/extensions");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "hold-setter.js"), `
    import { writeFileSync, existsSync } from "node:fs";
    export default function(pi) {
      pi.on("model_select", async () => {
        if (!existsSync(${JSON.stringify(gate)})) return;
        writeFileSync(${JSON.stringify(marker)}, String(process.pid));
        while (existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));
      });
    }
  `);
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  try {
    await f.start(); await f.turn("Persist before changing options"); await f.boundary();
    assert.equal(f.spawned().length, 1);
    const pid = f.spawned()[0].pid;
    writeFileSync(gate, "hold native model setter");
    const changing = f.turn("Never dispatch this input", { model: models.responses, reasoningLevel: "high" })
      .then(() => ({ accepted: true }), (error) => ({ error }));
    await until(() => existsSync(marker), "native set_model entered model_select");
    assert.equal(Number(readFileSync(marker, "utf8")), pid);
    assert.equal(f.spawned().length, 1, "Option changes do not replace the session");
    await f.stop();
    assert.equal(alive(pid), false, "Stop releases the child before its response");
    await changing;
    const snapshot = readFileSync(f.savedPath(), "utf8"), count = f.messages.length;
    unlinkSync(gate);
    await f.rpc("provider/health", { providerId: "vrata", cwd: f.cwd });
    assert.equal(f.gateway.requests.length, 1, "no generation follows cancellation");
    assert.equal(readFileSync(f.savedPath(), "utf8"), snapshot);
    assert.equal(f.messages.slice(count).some((m) => m.method === "thread/delta" || m.method === "item/tool/call"), false);
    assert.match(JSON.stringify(f.saved().messages), /Persist before changing options/);
    assert.doesNotMatch(JSON.stringify(f.saved().messages), /Never dispatch this input/);
    f.transport.child.stdin.end();
    await until(() => f.transport.child.exitCode !== null, "host exits without forced termination", 12000);
    assert.equal(f.transport.child.exitCode, 0);
  } finally {
    for (const { pid } of f.spawned()) if (alive(pid)) process.kill(pid, "SIGKILL");
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

for (const consume of [false, true]) {
  test(`steer acknowledgment follows native consumption, Stop ${consume ? "after" : "before"} consumption`, async (t) => {
    const held = [];
    const f = await fixture(t, { onChat({ response, index }) {
      if (index < (consume ? 2 : 1)) { held.push(response); chunk(response, { role: "assistant", content: "Held native work" }); }
      else answer(response);
    } });
    const { providerThreadId } = await f.start(); await f.turn("Initial input");
    await until(() => held.length === 1, "held generation");
    const id = await f.steer("Consumed steer marker");
    const accepted = () => f.events().filter((event) => event.type === "turn/input/accepted" && event.clientRequestId === id);
    assert.equal(accepted().length, 0, "Queue admission is not conversation consumption");
    assert.equal(f.gateway.requests.length, 1, "Same-option steer does not cancel the active run");
    assert.equal(held[0].destroyed, false);
    if (consume) {
      finish(held[0]);
      await until(() => held.length === 2, "steered model request");
      await until(() => accepted().length === 1, "consumed input acknowledgment");
      assert.match(JSON.stringify(f.gateway.requests[1].body.messages), /Consumed steer marker/);
    }
    await f.stop();
    assert.equal(accepted().length, consume ? 1 : 0);
    const history = JSON.stringify(f.saved().messages);
    if (consume) assert.match(history, /Consumed steer marker/);
    else assert.doesNotMatch(history, /Consumed steer marker/);
    const count = f.messages.length, requests = f.gateway.requests.length;
    for (const response of held) if (!response.writableEnded) finish(response);
    await sleep(50);
    assert.equal(f.messages.length, count);
    assert.equal(f.gateway.requests.length, requests);
    await f.resume(providerThreadId);
    await f.turn("Resume after steer Stop", { model: "vrata-setup", reasoningLevel: undefined });
    assert.equal((await f.boundary()).status, "completed");
    const resumed = JSON.stringify(f.gateway.requests.at(-1).body.messages);
    if (consume) assert.match(resumed, /Consumed steer marker/);
    else assert.doesNotMatch(resumed, /Consumed steer marker/);
  });
}

test("dynamic RPC error preserves native recovery", async (t) => {
  const f = await fixture(t, { onChat({ response, index }) { if (!index) callTool(response); else answer(response, "Tool recovered"); } });
  await f.start({ dynamicTools: [dynamicTool] }); await f.turn("Run the tool");
  const call = await f.toolCall();
  f.replyError(call.id, "Synthetic RPC failure");
  assert.equal((await f.boundary()).status, "completed");
  const saved = f.saved().messages.find((message) => message.role === "toolResult");
  assert.equal(saved.isError, true);
  assert.match(JSON.stringify(saved), /Synthetic RPC failure/);
  assert.equal(f.deltas().find((delta) => delta.kind === "item.close" && delta.item?.type === "tool").status, "failed");
  assert.equal(f.gateway.requests.length, 2);
});

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
  const beforeClose = existsSync(f.savedPath()) ? readFileSync(f.savedPath(), "utf8") : null;
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
  assert.equal(existsSync(f.savedPath()) ? readFileSync(f.savedPath(), "utf8") : null, beforeClose);
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
