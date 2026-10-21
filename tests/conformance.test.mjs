import assert from "node:assert/strict";
import test from "node:test";
import { experimental_runBridgeConformance } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { answer, chunk, finish, fixture, options, textInput } from "./bridge-fixture.mjs";

test("packaged native bridge passes the canonical SDK conformance suite", async (t) => {
  const f = await fixture(t, { onChat({ response, body }) {
    const lastUser = body.messages.findLast((message) => message.role === "user");
    if (JSON.stringify(lastUser).includes("CONFORMANCE_HOLD")) chunk(response, { role: "assistant", content: "Waiting for interruption" });
    else if (JSON.stringify(lastUser).includes("CONFORMANCE_ZERO")) finish(response);
    else answer(response, "Conformance response");
  } });
  f.transport.takeMessages();
  const report = await experimental_runBridgeConformance({
    transport: f.transport, providerId: "vrata",
    session: { cwd: f.cwd, options, promptInput: textInput("Reply briefly"), zeroWorkPromptInput: textInput("CONFORMANCE_ZERO"), interruptiblePromptInput: textInput("CONFORMANCE_HOLD") },
    timeoutMs: 30000,
  });
  t.diagnostic(`SDK scenarios: ${report.results.filter((r) => r.status === "pass").length}/${report.results.length} passed`);
  assert.equal(report.passed, true, JSON.stringify(report.results, null, 2));
  for (const id of ["session/fork-identity", "turn/settles-without-activity", "stop/release-not-interrupted", "stop/interrupt-settles-before-result"]) {
    assert.equal(report.results.find((r) => r.id === id)?.status, "pass", JSON.stringify(report.results));
  }
  assert.equal(report.results.some((r) => r.status === "fail"), false);
});
