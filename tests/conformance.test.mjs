import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_captureBridgeJsonRpcOutput,
  experimental_runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { answer, bridge, chunk, createGateway, options, textInput } from "./bridge-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "vrata-conformance-"));
const dataDir = join(root, "data");
mkdirSync(dataDir);
const gateway = await createGateway({ onChat({ response, body }) {
  const lastUser = body.messages.findLast((message) => message.role === "user");
  if (JSON.stringify(lastUser).includes("CONFORMANCE_HOLD")) {
    chunk(response, { role: "assistant", content: "Waiting for interruption" });
  } else answer(response, "Conformance response");
} });
writeFileSync(join(dataDir, "credentials.json"), JSON.stringify({
  apiKey: "synthetic-conformance-key", baseUrl: gateway.url,
}), { mode: 0o600 });
// start belongs to this capture lifecycle; a closed runtime ignores requests.
bridge.start({ pluginId: "vrata", dataDir, tempDir: join(root, "temp") });
const capture = experimental_captureBridgeJsonRpcOutput();
let report;
try {
  report = await experimental_runBridgeConformance({
    transport: { send: bridge.handleLine, takeMessages: capture.takeMessages },
    providerId: "vrata",
    session: {
      cwd: root, options,
      promptInput: textInput("Reply briefly"),
      zeroWorkPromptInput: textInput(""),
      interruptiblePromptInput: textInput("CONFORMANCE_HOLD"),
    },
    timeoutMs: 5000,
  });
} finally {
  bridge.onClose();
  try { await gateway.close(); }
  finally {
    capture.restore();
    rmSync(root, { recursive: true, force: true });
  }
}
assert.equal(report.passed, true, JSON.stringify(report.results, null, 2));
assert.equal(report.results.filter((result) => result.status === "pass").length, 16, JSON.stringify(report.results, null, 2));
assert.equal(report.results.some((result) => result.status === "fail"), false);
process.stdout.write("Bundled bridge SDK conformance: 16/16 passed\n");
