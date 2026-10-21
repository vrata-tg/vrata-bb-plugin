import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureEmbeddedPi } from "../dist/tests/embedded-pi.js";
import { ensureLegacySession } from "../dist/tests/legacy-session.js";

const id = "3242612e-76ad-4502-a13e-ad48e3c8cf1b";
const usage = { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const messages = [
  { role: "user", content: [{ type: "text", text: "legacy request" }], timestamp: 1 },
  { role: "assistant", api: "openai-completions", provider: "vrata", model: "gemini-3.8-flash", content: [{ type: "thinking", thinking: "legacy reasoning", thinkingSignature: "opaque-signature" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.txt" } }], stopReason: "toolUse", usage, timestamp: 2 },
  { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "before" }, { type: "image", mimeType: "image/png", data: "opaque-image-fixture" }, { type: "text", text: "after" }], isError: true, timestamp: 3 },
];

test("legacy import uses the embedded SessionManager, preserves content and final selections, and publishes once", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "vrata-migration-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await ensureEmbeddedPi(dataDir);
  const sessionDir = join(dataDir, "pi-sessions");
  const args = { dataDir, cwd: dataDir, providerThreadId: id, sessionDir, sdkEntry: runtime.sdkEntry };
  await mkdir(join(dataDir, "sessions"));
  const originalPath = join(dataDir, "sessions", `${id}.json`);
  const original = JSON.stringify({ messages, selectedModelId: "gpt-6-luna", selectedReasoningLevel: "none", totalUsage: { totalTokens: 17 } });
  await writeFile(originalPath, original);
  const paths = await Promise.all(Array.from({ length: 4 }, () => ensureLegacySession(args)));
  assert.equal(new Set(paths).size, 1);
  const path = paths[0];
  const bytes = await readFile(path, "utf8");
  const { SessionManager } = await import(pathToFileURL(runtime.sdkEntry).href);
  const manager = SessionManager.open(path, sessionDir);
  const context = manager.buildSessionContext();
  assert.equal(manager.getSessionId(), id);
  assert.deepEqual(context.messages, messages);
  assert.deepEqual(context.model, { provider: "vrata.tg", modelId: "gpt-6-luna" });
  assert.equal(context.thinkingLevel, "off");
  assert.equal(await readFile(originalPath, "utf8"), original);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(originalPath, "malformed source after successful migration");
  assert.equal(await ensureLegacySession(args), path);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await readdir(sessionDir), [`${id}.jsonl`]);
});

test("missing and empty legacy snapshots are distinct from malformed history", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "vrata-migration-empty-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtime = await ensureEmbeddedPi(dataDir);
  const args = { dataDir, cwd: dataDir, providerThreadId: id, sessionDir: join(dataDir, "native"), sdkEntry: runtime.sdkEntry };
  assert.equal(await ensureLegacySession(args), undefined);
  assert.equal(await ensureLegacySession({ ...args, providerThreadId: "../../outside" }), undefined);
  await mkdir(join(dataDir, "sessions"));
  const file = join(dataDir, "sessions", `${id}.json`);
  await writeFile(file, "private-malformed-content");
  await assert.rejects(ensureLegacySession(args), (error) => !error.message.includes("private-malformed-content"));
  await writeFile(file, JSON.stringify({ messages: [], selectedModelId: "gpt-6-luna", selectedReasoningLevel: "high" }));
  const path = await ensureLegacySession(args);
  const { SessionManager } = await import(pathToFileURL(runtime.sdkEntry).href);
  const manager = SessionManager.open(path, args.sessionDir);
  assert.deepEqual(manager.buildSessionContext().messages, []);
  assert.equal(manager.buildSessionContext().thinkingLevel, "high");
  assert.equal(manager.buildSessionContext().model.modelId, "gpt-6-luna");
});
