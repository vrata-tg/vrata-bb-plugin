import assert from "node:assert/strict";
import test from "node:test";
import { experimental_createBridgeDeltaEventCollector } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createPiDeltaTranslator } from "../dist/tests/pi-events.js";

const assistantEnd = {
  type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }],
    usage: { input: 8, output: 2, totalTokens: 10 } }],
};

test("assistant messages complete before tools and the final message completes only once", () => {
  const translator = createPiDeltaTranslator();
  const collector = experimental_createBridgeDeltaEventCollector("vrata");
  const events = [];
  const send = (event) => events.push(...collector.assembleMessage({
    method: "thread/delta", params: { threadId: "thread", deltas: translator.translate(event, { cwd: "/project" }) },
  }));
  const start = () => send({ type: "message_start", message: { role: "assistant", content: [] } });
  const text = (delta) => send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  send({ type: "agent_start" });
  start();
  text("Checking.");
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking." }] } });
  const preamble = events.find((event) => event.type === "item/started" && event.item.type === "agentMessage");
  assert.ok(events.some((event) => event.type === "item/completed" && event.item.id === preamble.item.id), "Close the preamble before opening a tool");
  send({ type: "tool_execution_start", toolCallId: "command", toolName: "bash", args: { command: "pwd" } });
  send({ type: "tool_execution_end", toolCallId: "command", toolName: "bash", result: "ok", isError: false });
  start();
  text("Done");
  text("Details");
  const final = { role: "assistant", content: [{ type: "text", text: "Done" }, { type: "text", text: "Details" }] };
  send({ type: "message_end", message: final });
  send({ type: "agent_end", messages: [final] });
  send({ type: "agent_settled", messages: [final] });
  const started = events.filter((event) => event.type === "item/started");
  const completed = events.filter((event) => event.type === "item/completed");
  assert.equal(started.length, 3);
  assert.deepEqual(completed.map((event) => event.item.id), started.map((event) => event.item.id));
  assert.deepEqual(completed.filter((event) => event.item.type === "agentMessage").map((event) => event.item.text), ["Checking.", "Done\nDetails"]);
  assert.equal(events.filter((event) => event.type === "turn/completed").length, 1);
});

test("retryable assistant errors close partial text without closing the turn", () => {
  const translator = createPiDeltaTranslator();
  const message = { role: "assistant", content: [{ type: "text", text: "Partial" }], stopReason: "error", errorMessage: "Connection error." };
  translator.translate({ type: "agent_start" });
  translator.translate({ type: "message_start", message: { role: "assistant", content: [] } });
  translator.translate({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial" } });
  assert.equal(translator.translate({ type: "message_end", message })[0].kind, "item.textClose");
  const retry = translator.translate({ type: "agent_end", messages: [message], willRetry: true });
  assert.deepEqual(retry.map((delta) => delta.kind), ["provider.error"]);
  assert.equal(retry[0].willRetry, true);
  translator.translate({ type: "agent_start" });
  assert.equal(translator.translate(assistantEnd)[0].kind, "item.textClose");
});

test("each session owns tool shapes and usage; model changes use live context", () => {
  const first = createPiDeltaTranslator(), second = createPiDeltaTranslator();
  first.translate({ type: "tool_execution_start", toolCallId: "shared", toolName: "bash", args: { command: "pwd" } }, { cwd: "/one" });
  second.translate({ type: "tool_execution_start", toolCallId: "shared", toolName: "edit", args: { path: "file", oldText: "a", newText: "b" } });
  const result = { type: "tool_execution_end", toolCallId: "shared", result: { content: [{ type: "text", text: "ok" }] }, isError: false };
  assert.deepEqual(first.translate({ ...result, toolName: "bash" })[0].item, { type: "command", command: "pwd", cwd: "/one" });
  assert.equal(second.translate({ ...result, toolName: "edit" })[0].item.type, "fileChange");
  const usage = (translator, size) => translator.translate(assistantEnd, { modelContextWindow: size }).find((d) => d.kind === "usage");
  assert.equal(usage(first, 100).total.totalTokens, 10);
  const changed = usage(first, 200);
  assert.equal(changed.total.totalTokens, 20);
  assert.equal(changed.modelContextWindow, 200);
  assert.equal(usage(second, 300).total.totalTokens, 10);
});

test("unknown and malformed Pi events remain observable while routine noise is ignored", () => {
  const translator = createPiDeltaTranslator();
  for (const event of [
    { type: "new_pi_event", payload: "diagnostic" },
    { type: "tool_execution_end", toolName: "missing-call-id" },
    { type: "message_update", assistantMessageEvent: { type: "new_content", delta: "diagnostic" } },
  ]) {
    const [delta] = translator.translate(event);
    assert.equal(delta.kind, "unhandled");
    assert.deepEqual(delta.raw.params.message, event);
  }
  assert.deepEqual(translator.translate({ type: "turn_end" }), []);
  assert.deepEqual(translator.translate({ type: "message_start", message: { role: "user", content: "input" } }), []);
  assert.deepEqual(translator.translate({ type: "message_start", message: { role: "custom", content: "visible", display: true } }), [{ kind: "input.provider", text: "visible" }]);
});
