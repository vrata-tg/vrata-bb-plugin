import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  answer, bridge, callTool, chunk, dynamicTool, finish, fixture, sleep, textInput, until,
} from "./bridge-fixture.mjs";

// The SDK captures process.stdout as JSON-RPC, so run serially and print only
// after each fixture restores stdout (node:test's reporter also writes there).
const cases = [];
function test(name, run) { cases.push({ name, run }); }

function assertBoundaryBeforeResponse(f, responseId, status = "interrupted") {
  const responseIndex = f.messages.findIndex((message) => message.id === responseId);
  const boundaryIndex = f.messages.findLastIndex((message) =>
    message.method === "thread/delta" && message.params.deltas.some((delta) =>
      delta.kind === "turn.boundary" && delta.status === status));
  assert.ok(boundaryIndex >= 0 && boundaryIndex < responseIndex, "Terminal boundary must precede stop response");
}
function transcriptText(saved) { return JSON.stringify(saved.messages); }
function toolReply(f, call, text, success = true) {
  f.reply(call.id, { success, contentItems: [{ type: "inputText", text }] });
}

test("interrupt during catalog cancels generation and settles before the response", async (t) => {
  const held = [];
  let hold = true;
  const f = await fixture(t, { onModels({ respond }) { if (hold) held.push(respond); else respond(); } });
  await f.start();
  await f.turn("Cancel preparation");
  await until(() => held.length === 2, "both catalog requests");
  const stopped = await f.stop();
  assertBoundaryBeforeResponse(f, stopped.id);
  hold = false;
  held.splice(0).forEach((respond) => respond());
  await sleep(100);
  assert.equal(f.gateway.requests.length, 0);
  // Interrupt retains the session; the next turn must not need resume.
  await f.turn("Continue after interruption");
  assert.equal((await f.boundary(2)).status, "completed");
  assert.equal(f.gateway.requests.length, 1);
});

test("interrupt persists the partial answer and an already accepted steer", async (t) => {
  let held;
  const f = await fixture(t, { onChat({ response }) {
    chunk(response, { role: "assistant", content: "Persist this partial answer" });
    held = response;
  } });
  await f.start();
  await f.turn("Persist this user input");
  await until(() => f.deltas().some((delta) => delta.kind === "item.textDelta"), "partial text");
  const steerId = await f.steer("Accepted steer must survive interruption");
  assert.ok(f.deltas().some((delta) => delta.kind === "input.accepted" && delta.clientRequestId === steerId));
  const stopped = await f.stop();
  assertBoundaryBeforeResponse(f, stopped.id);
  const saved = transcriptText(f.saved());
  assert.match(saved, /Persist this user input/);
  assert.match(saved, /Persist this partial answer/);
  assert.match(saved, /Accepted steer must survive interruption/);
  const before = f.messages.length;
  finish(held);
  await sleep(50);
  assert.equal(f.messages.length, before, "Late stream completion must not emit after interrupt");
});

test("release suppresses active and late deltas without fabricating a boundary", async (t) => {
  let held;
  const f = await fixture(t, { onChat({ response }) {
    chunk(response, { role: "assistant", content: "Partial before release" });
    held = response;
  } });
  await f.start();
  await f.turn("Detach this session");
  await until(() => f.deltas().some((delta) => delta.kind === "item.textDelta"), "partial text");
  const before = f.deltas().length;
  await f.stop("release");
  finish(held);
  await sleep(50);
  assert.equal(f.deltas().length, before);
  assert.equal(f.deltas().filter((delta) => delta.kind === "turn.boundary").length, 0);
  await f.stop("release");
  assert.equal(f.deltas().length, before, "Repeated release must also be silent");
});

test("concurrent same-thread starts leave no orphan generation or tools after stop", async (t) => {
  const held = [];
  const f = await fixture(t, { onChat({ response, body }) {
    held.push({ response, body });
    chunk(response, { role: "assistant", content: "Held replacement turn" });
  } });
  await f.start();
  const markers = ["FIRST_REPLACEMENT", "SECOND_REPLACEMENT"];
  const started = await Promise.all(markers.map((marker) => f.start({
    dynamicTools: [dynamicTool], input: textInput(marker),
  })));
  assert.notEqual(started[0].providerThreadId, started[1].providerThreadId);
  const currentMarker = markers[started.findIndex((session) =>
    session.providerThreadId === f.current.providerThreadId)];
  // The first replacement may be cancelled at catalog discovery. Only the
  // current session must reach the endpoint; never require two simultaneous POSTs.
  await until(() => held.some(({ body }) => JSON.stringify(body.messages).includes(currentMarker)), "current replacement request");
  const stopped = await f.stop();
  assertBoundaryBeforeResponse(f, stopped.id);
  const requestCount = f.gateway.requests.length;
  const messageCount = f.messages.length;
  for (const { response } of held.splice(0)) callTool(response);
  await sleep(150);
  assert.equal(f.gateway.requests.length, requestCount, "Stopped replacements must not start further generation");
  assert.equal(f.messages.length, messageCount, "Replaced sessions must not emit late deltas or RPC calls");
  assert.equal(f.messages.some((message) => message.method === "item/tool/call"), false);
});

test("onClose synchronously snapshots partial work and cannot write into a restarted context", async (t) => {
  let held;
  const f = await fixture(t, { onChat({ response }) {
    chunk(response, { role: "assistant", content: "Synchronous shutdown snapshot" });
    held = response;
  } });
  const { providerThreadId } = await f.start();
  await f.turn("User before shutdown");
  await until(() => f.deltas().some((delta) => delta.kind === "item.textDelta"), "partial text");
  const oldPath = f.savedPath();
  const beforeClose = f.messages.length;
  bridge.onClose();
  // Read immediately: no await is allowed before proving synchronous persistence.
  const snapshot = readFileSync(oldPath, "utf8");
  assert.match(snapshot, /Synchronous shutdown snapshot/);
  assert.match(snapshot, /User before shutdown/);
  assert.equal(f.messages.length, beforeClose);
  f.restart();
  finish(held);
  await sleep(100);
  assert.equal(readFileSync(oldPath, "utf8"), snapshot);
  assert.equal(existsSync(f.savedPath(providerThreadId)), false, "An old turn must not save under the new dataDir");
  assert.equal(f.messages.length, beforeClose);
  assert.equal(f.gateway.requests.length, 1);
});

test("onClose rejects late catalog work and pending RPC replies across restart", async (t) => {
  const held = [];
  const f = await fixture(t, { onModels({ respond }) { held.push(respond); } });
  await f.start();
  await f.turn("Must never reach the generation endpoint");
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "old-catalog-rpc", method: "model/list", params: {} }));
  await until(() => held.length === 4, "turn and RPC catalog requests");
  bridge.onClose();
  const before = f.messages.length;
  f.restart();
  held.splice(0).forEach((respond) => respond());
  await sleep(100);
  assert.equal(f.gateway.requests.length, 0);
  assert.equal(f.messages.length, before);
  assert.equal(existsSync(join(f.dataDir, "sessions")), false);
});

test("URL and key stay paired during a turn and the next turn uses the new pair", async (t) => {
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) callTool(response);
    else answer(response, "Completed with the original credential snapshot");
  } });
  await f.start({ dynamicTools: [dynamicTool] });
  await f.turn("Start with account A");
  const call = await f.toolCall();
  const other = await f.anotherGateway();
  f.configure(other, "synthetic-key-b");
  toolReply(f, call, "Continue the original turn");
  await f.boundary();
  assert.equal(f.gateway.requests.length, 2);
  assert.ok(f.gateway.requests.every((request) => request.authorization === "Bearer synthetic-key-a"));
  assert.equal(other.requests.length, 0);
  await f.turn("Use account B with the same model");
  await f.boundary(2);
  assert.equal(f.gateway.requests.length, 2);
  assert.equal(other.requests.length, 1);
  assert.equal(other.requests[0].authorization, "Bearer synthetic-key-b");
});

test("explicit per-turn model and reasoning survive release and resume", async (t) => {
  const f = await fixture(t);
  const { providerThreadId } = await f.start();
  await f.turn("First selection", { model: "mock-code", reasoningLevel: "high" });
  await f.boundary();
  await f.turn("Change selection", { model: "mock-other", reasoningLevel: "low" });
  await f.boundary(2);
  assert.equal(f.saved().selectedModelId, "mock-other");
  assert.equal(f.saved().selectedReasoningLevel, "low");
  await f.stop("release");
  await f.resume(providerThreadId);
  await f.turn("Continue with the saved selection", { model: "vrata-setup" });
  await f.boundary();
  assert.equal(f.gateway.requests.at(-1).body.model, "mock-other");
  assert.equal(f.gateway.requests.at(-1).body.reasoning_effort, "low");
});

test("a high-only model advertises a usable default and starts without explicit reasoning", async (t) => {
  const f = await fixture(t, {
    models: [{ id: "gpt-5-pro", gateway_metadata: {
      supports_reasoning: true, supports_tools: false,
      verified_transport: "responses", max_input_tokens: 32000, max_output_tokens: 4096,
    } }],
    onResponses({ response }) {
      // A deliberate upstream rejection proves the bridge reached the actual Pi
      // transport; it must not fail locally while choosing an unsupported effort.
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"message":"Synthetic terminal rejection after request acceptance"}}');
    },
  });
  const { result: catalog } = await f.rpc("model/list", {});
  const model = catalog.models.find((entry) => entry.id === "gpt-5-pro");
  const supported = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  assert.deepEqual(supported, ["high"]);
  assert.ok(supported.includes(model.defaultReasoningEffort), "Catalog default must be a realizable Pi effort");
  await f.start({
    options: { model: "gpt-5-pro", reasoningLevel: undefined },
    input: textInput("Use the model's supported default"),
  });
  assert.equal((await f.boundary()).status, "failed", "The synthetic HTTP rejection settles the turn");
  assert.equal(f.gateway.requests.length, 1, "Implicit reasoning must reach the transport exactly once");
  assert.equal(f.gateway.requests[0].path, "/v1/responses");
  assert.equal(f.gateway.requests[0].body.reasoning.effort, "high");
  assert.equal(f.saved().selectedModelId, "gpt-5-pro");
  assert.equal(f.saved().selectedReasoningLevel, "high");
});

test("steer acceptance is correlated and the injected input reaches Pi", async (t) => {
  let held;
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) {
      chunk(response, { role: "assistant", content: "Before steer" });
      held = response;
    } else answer(response, "After steer");
  } });
  await f.start();
  await f.turn("Initial input");
  await until(() => held, "open stream");
  const clientRequestId = await f.steer("Injected user instruction");
  assert.equal(f.deltas().filter((delta) => delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId).length, 1);
  finish(held);
  await f.boundary();
  assert.equal(f.gateway.requests.length, 2);
  assert.match(JSON.stringify(f.gateway.requests[1].body.messages), /Injected user instruction/);
});

test("dynamic tools round-trip through SDK and preserve ordered text and image content", async (t) => {
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) callTool(response);
    else answer(response);
  } });
  await f.start({ dynamicTools: [dynamicTool] });
  await f.turn("Call the configured tool");
  const call = await f.toolCall();
  assert.equal(call.params.threadId, f.current.threadId);
  assert.equal(call.params.providerThreadId, f.current.providerThreadId);
  assert.equal(call.params.tool, dynamicTool.name);
  assert.deepEqual(call.params.arguments, { value: "fixture" });
  const text = "Complete tool output ".repeat(2000);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=";
  f.reply(call.id, { success: true, contentItems: [
    { type: "inputText", text },
    { type: "inputImage", imageUrl: `data:image/png;base64,${png}` },
    { type: "inputText", text: "After image" },
  ] });
  assert.equal((await f.boundary()).status, "completed");
  const close = f.deltas().find((delta) => delta.kind === "item.close" && delta.item?.type === "tool");
  assert.equal(close.status, "completed");
  assert.deepEqual(close.item.result.content, [
    { type: "text", text }, { type: "image", mimeType: "image/png", data: png },
    { type: "text", text: "After image" },
  ]);
  assert.equal(f.gateway.requests.length, 2);
  assert.ok(JSON.stringify(f.gateway.requests[1].body.messages).includes(text));
  assert.ok(JSON.stringify(f.gateway.requests[1].body.messages).includes(png));
});

for (const responseKind of ["tool failure", "RPC error"]) {
  test(`dynamic ${responseKind} becomes a failed tool result and allows model recovery`, async (t) => {
    const f = await fixture(t, { onChat({ response, index }) {
      if (index === 0) callTool(response);
      else answer(response, "Recovered after tool failure");
    } });
    await f.start({ dynamicTools: [dynamicTool] });
    await f.turn("Try a failing tool");
    const call = await f.toolCall();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=";
    const expectedContent = [
      { type: "text", text: "Synthetic tool failure before image" },
      { type: "image", mimeType: "image/png", data: png },
      { type: "text", text: "Failure details after image" },
    ];
    if (responseKind === "tool failure") f.reply(call.id, { success: false, contentItems: [
      { type: "inputText", text: expectedContent[0].text },
      { type: "inputImage", imageUrl: `data:image/png;base64,${png}` },
      { type: "inputText", text: expectedContent[2].text },
    ] });
    else bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "Synthetic RPC failure" } }));
    assert.equal((await f.boundary()).status, "completed", "The model may recover from a failed tool");
    const close = f.deltas().find((delta) => delta.kind === "item.close" && delta.item?.type === "tool");
    assert.equal(close.status, "failed");
    const savedResult = f.saved().messages.find((message) => message.role === "toolResult");
    assert.equal(savedResult.isError, true);
    assert.equal(f.gateway.requests.length, 2);
    const nextMessages = f.gateway.requests[1].body.messages;
    assert.match(JSON.stringify(nextMessages), /Synthetic (tool|RPC) failure/);
    if (responseKind === "tool failure") {
      assert.deepEqual(savedResult.content, expectedContent);
      assert.deepEqual(close.item.result.content, expectedContent);
      const toolIndex = nextMessages.findIndex((message) => message.role === "tool");
      assert.ok(toolIndex >= 0);
      // Pinned Pi joins tool text in order and sends images in a following user
      // message because chat-completions tool messages cannot carry image blocks.
      assert.equal(nextMessages[toolIndex].content, `${expectedContent[0].text}\n${expectedContent[2].text}`);
      assert.equal(nextMessages[toolIndex + 1].role, "user");
      assert.deepEqual(nextMessages[toolIndex + 1].content.filter((part) => part.type === "image_url"), [
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ]);
    }
  });
}

test("interrupt settles a pending dynamic tool and ignores its late reply", async (t) => {
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) callTool(response);
    else answer(response);
  } });
  await f.start({ dynamicTools: [dynamicTool] });
  await f.turn("Wait for tool response");
  const call = await f.toolCall();
  const stopped = await f.stop();
  assertBoundaryBeforeResponse(f, stopped.id);
  assert.ok(f.deltas().some((delta) => delta.kind === "item.close" && delta.item?.type === "tool" && delta.status === "interrupted"));
  const snapshot = readFileSync(f.savedPath(), "utf8");
  const before = f.messages.length;
  toolReply(f, call, "LATE_RESULT_MUST_NOT_BE_USED");
  await sleep(100);
  assert.equal(f.messages.length, before);
  assert.equal(f.gateway.requests.length, 1);
  assert.equal(readFileSync(f.savedPath(), "utf8"), snapshot);
  await f.turn("Still usable after cancellation");
  assert.equal((await f.boundary(2)).status, "completed");
  assert.doesNotMatch(JSON.stringify(f.gateway.requests[1].body.messages), /LATE_RESULT_MUST_NOT_BE_USED/);
});

test("disallowed stock and dynamic tools cannot be advertised or executed", async (t) => {
  let forbiddenPath;
  const f = await fixture(t, { onChat({ response, index }) {
    if (index > 0) return answer(response);
    chunk(response, { role: "assistant", tool_calls: [
      { index: 0, id: "blocked-stock", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `touch '${forbiddenPath}'` }) } },
      { index: 1, id: "blocked-dynamic", type: "function", function: { name: dynamicTool.name, arguments: '{"value":"forbidden"}' } },
    ] });
    chunk(response, {}, { finishReason: "tool_calls" });
    response.end("data: [DONE]\n\n");
  } });
  forbiddenPath = join(f.root, "must-not-exist");
  await f.start({ dynamicTools: [dynamicTool], disallowedTools: ["bash", dynamicTool.name] });
  await f.turn("Attempt excluded tools");
  await f.boundary();
  const names = f.gateway.requests[0].body.tools.map((tool) => tool.function.name);
  assert.ok(names.includes("read"), "Allowed stock tools remain available");
  assert.ok(!names.includes("bash") && !names.includes(dynamicTool.name));
  assert.equal(existsSync(forbiddenPath), false);
  assert.equal(f.messages.some((message) => message.method === "item/tool/call"), false);
  const results = f.saved().messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.isError));
});

test("HTTP 401 is actionable without exposing the upstream body or credential in events or history", async (t) => {
  const secret = "synthetic-secret-must-not-leak";
  const upstream = `PRIVATE_UPSTREAM_BODY Authorization: Bearer ${secret}`;
  const f = await fixture(t, { onChat({ response }) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: upstream } }));
  } });
  f.configure(f.gateway, secret);
  await f.start();
  await f.turn("Trigger authorization failure");
  assert.equal((await f.boundary()).status, "failed");
  assert.equal(f.gateway.requests.length, 1, "Failed paid requests are not retried");
  const output = JSON.stringify(f.messages);
  const saved = readFileSync(f.savedPath(), "utf8");
  assert.ok(!output.includes(secret) && !saved.includes(secret));
  assert.ok(!output.includes("PRIVATE_UPSTREAM_BODY") && !saved.includes("PRIVATE_UPSTREAM_BODY"));
  assert.match(output, /ключ|401|доступ/i);
  assert.match(saved, /Trigger authorization failure/);
});

test("provider health does not expose malformed catalog response bodies", async (t) => {
  const f = await fixture(t, { onModels({ response }) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("LEAK123 malformed upstream catalog");
  } });
  const { result } = await f.rpc("provider/health", { providerId: "vrata" });
  assert.equal(result.supported, true);
  assert.equal(result.health.status, "unknown");
  assert.ok(result.health.statusMessage?.trim(), "Health failures should retain a safe diagnostic");
  assert.doesNotMatch(JSON.stringify(f.messages), /LEAK123|malformed upstream catalog/);
  assert.equal(f.gateway.catalogRequests.length, 2);
  assert.equal(f.gateway.requests.length, 0, "Health checks must not generate completions");
});

test("thinking, cached token usage and context estimates appear in SDK deltas", async (t) => {
  const f = await fixture(t, { onChat({ response }) {
    chunk(response, { role: "assistant", reasoning_content: "Synthetic reasoning text" });
    chunk(response, { content: "Final answer" });
    finish(response, {
      prompt_tokens: 10, completion_tokens: 6, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  } });
  await f.start();
  await f.turn("Show thinking and usage", { reasoningLevel: "high" });
  await f.boundary();
  assert.ok(f.deltas().some((delta) => delta.channel === "reasoningText" && delta.text === "Synthetic reasoning text"));
  const usage = f.deltas().find((delta) => delta.kind === "usage");
  assert.deepEqual(usage.last, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 16 });
  assert.deepEqual(usage.total, usage.last);
  const context = f.deltas().find((delta) => delta.kind === "contextWindow");
  assert.ok(context.estimated && context.used > 0 && context.size === 32000);
  await f.turn("Accumulate usage", { reasoningLevel: "high" });
  await f.boundary(2);
  assert.equal(f.deltas().filter((delta) => delta.kind === "usage").at(-1).total.totalTokens, 32);
});

test("equal input and output model limits still allow a short request", async (t) => {
  const f = await fixture(t, {
    models: [{ id: "mock-code", gateway_metadata: {
      supports_tools: false, supports_reasoning: false,
      verified_transport: "chat_completions", max_input_tokens: 32000, max_output_tokens: 32000,
    } }],
    onChat({ request, response }) {
      assert.equal(request.method, "POST");
      answer(response, "Short response within the context window");
    },
  });
  await f.start();
  await f.turn("Reply briefly.");
  assert.equal((await f.boundary()).status, "completed");
  assert.equal(f.gateway.requests.length, 1);
  assert.equal(f.gateway.requests[0].path, "/v1/chat/completions");
  assert.ok(f.deltas().some((delta) => delta.kind === "item.textClose"
    && delta.text === "Short response within the context window"));
});

test("oversized tool output blocks the next request while preserving the complete history", async (t) => {
  const f = await fixture(t, { onChat({ response, index }) {
    if (index === 0) callTool(response);
    else answer(response);
  } });
  await f.start({ dynamicTools: [dynamicTool] });
  await f.turn("Keep the complete oversized result");
  const call = await f.toolCall();
  const largeResult = "UNTRUNCATED_RESULT_" + "x".repeat(200000) + "_END";
  toolReply(f, call, largeResult);
  assert.equal((await f.boundary()).status, "failed");
  assert.equal(f.gateway.requests.length, 1, "Context overflow must prevent the next paid request");
  const saved = f.saved();
  const result = saved.messages.find((message) => message.role === "toolResult");
  assert.equal(result.content.find((part) => part.type === "text").text, largeResult);
  assert.match(transcriptText(saved), /Keep the complete oversized result/);
  assert.match(JSON.stringify(f.deltas()), /контекст/i);
  const close = f.deltas().find((delta) => delta.kind === "item.close" && delta.item?.type === "tool");
  assert.equal(close.item.result.content[0].text, largeResult);
});

let failures = 0;
for (const { name, run } of cases) {
  const cleanups = [];
  let failure;
  try { await run({ after(cleanup) { cleanups.push(cleanup); } }); }
  catch (error) { failure = error; }
  finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { failure ??= error; }
    }
  }
  if (failure) {
    failures += 1;
    process.stderr.write(`FAIL ${name}\n${failure.stack ?? failure}\n`);
  } else process.stdout.write(`PASS ${name}\n`);
}
process.stdout.write(`Bridge regressions: ${cases.length - failures}/${cases.length} passed\n`);
if (failures) process.exitCode = 1;
