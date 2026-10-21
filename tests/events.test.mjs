import assert from "node:assert/strict";
import test from "node:test";
import { createPiDeltaTranslator } from "../dist/tests/pi-events.js";

const assistantEnd = {
  type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }],
    usage: { input: 8, output: 2, totalTokens: 10 } }],
};

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
