import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { answer, callTool, chunk, finish, fixture, models, options, png, until } from "./bridge-fixture.mjs";

// Raw is the pinned standalone CLI with ordinary guide registerProvider, not the
// candidate wrapper. Embedded uses packaged host.js and its extracted CLI.
async function lane(f, kind, model = models.chat) {
  if (kind === "raw") {
    const raw = await f.raw({ model });
    return { prompt: raw.prompt, settled: raw.settled, saved: raw.saved, entries: raw.entries,
      close: () => raw.child.close(), compact: () => raw.rpc("compact"), raw, path: raw.sessionFile };
  }
  await f.start({ options: { model } });
  return {
    prompt: (text) => f.turn(text, { model }), settled: async () => { const end = await f.boundary(); assert.equal(end.status, "completed"); return end; }, saved: f.saved, entries: f.entries,
    close: () => f.stop("release"), path: f.savedPath(),
    compact: async () => {
      await f.turn([{ type: "text", text: "/compact", mentions: [{ start: 0, end: 8, resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "compact", argumentHint: null } }] }], { model });
      await f.boundary();
    },
  };
}
function messagesWithoutRuntimeMetadata(messages) {
  return messages.filter((m) => m.role !== "system").map(({ role, content, isError, stopReason, toolName }) => ({ role, content: Array.isArray(content) ? content.map(({ type, text, data, mimeType, name, arguments: args }) => ({ type, text, data, mimeType, name, arguments: args })) : content, isError, stopReason, toolName }));
}

for (const [transport, model] of Object.entries(models)) {
  test(`raw guide / embedded ${transport}: same model, answer, usage and native tool schemas`, async (t) => {
    const results = [];
    for (const kind of ["raw", "embedded"]) {
      const f = await fixture(t, transport === "chat" ? { onChat({ response }) {
        chunk(response, { role: "assistant", reasoning_content: "Native reasoning marker" });
        answer(response);
      } } : {});
      const agent = await lane(f, kind, model);
      await agent.prompt("Shared transport prompt"); await agent.settled();
      const assistant = agent.saved().messages.findLast((m) => m.role === "assistant");
      assert.equal(assistant.stopReason, "stop");
      assert.equal(assistant.content.find((part) => part.type === "text").text, "Loopback answer");
      assert.ok(assistant.usage.totalTokens > 0);
      assert.equal(f.gateway.requests.length, 1);
      let contextWindow;
      if (kind === "raw") contextWindow = (await agent.raw.rpc("get_state")).result.model.contextWindow;
      else {
        const usage = await until(() => f.events().findLast((event) => event.type === "thread/tokenUsage/updated"), "BB usage event");
        assert.equal(usage.tokenUsage.last.totalTokens, assistant.usage.totalTokens);
        assert.equal(usage.tokenUsage.last.inputTokens, assistant.usage.input);
        assert.equal(usage.tokenUsage.last.outputTokens, assistant.usage.output);
        const context = await until(() => f.events().findLast((event) => event.type === "thread/contextWindowUsage/updated" && event.contextWindowUsage.usedTokens > 0), "BB context event");
        contextWindow = context.contextWindowUsage.modelContextWindow;
        assert.ok(contextWindow > 0);
        const text = f.events().filter((event) => event.type === "item/agentMessage/delta").map((event) => event.delta).join("");
        assert.equal(text, "Loopback answer");
        if (transport === "chat") {
          const thinking = f.events().filter((event) => event.type === "item/reasoning/textDelta").map((event) => event.delta).join("");
          assert.equal(thinking, "Native reasoning marker");
        }
      }
      if (transport === "chat") assert.equal(assistant.content.find((part) => part.type === "thinking").thinking, "Native reasoning marker");
      results.push({ path: f.gateway.requests[0].path, model: f.gateway.requests[0].body.model, tools: f.gateway.requests[0].body.tools, usage: assistant.usage, content: assistant.content, contextWindow });
      await agent.close();
    }
    assert.deepEqual(results[1], results[0]);
  });
}

for (const trust of ["ask", "never", "always"]) {
  test(`raw / embedded project context, skills and trust=${trust}`, async (t) => {
    const observations = [];
    for (const kind of ["raw", "embedded"]) {
      const f = await fixture(t, {}, { settings: { defaultProjectTrust: trust } });
      writeFileSync(join(f.cwd, "AGENTS.md"), "CONTEXT_FIXTURE_782 Follow project guidance.\n");
      const skillDir = join(f.cwd, ".pi", "skills", "review"); mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: SKILL_DISCOVERY_782\n---\nSKILL_BODY_782 execute the requested review.\n");
      const extensionDir = join(f.cwd, ".pi", "extensions"); mkdirSync(extensionDir);
      writeFileSync(join(extensionDir, "sentinel.js"), 'import {writeFileSync} from "node:fs"; export default function(pi) { pi.on("session_start", () => {writeFileSync("trust-sentinel", "loaded")}); }');
      const agent = await lane(f, kind);
      await agent.prompt(trust === "always" ? "/skill:review" : "Inspect context"); await agent.settled();
      const request = JSON.stringify(f.gateway.requests[0].body);
      const observation = { context: request.includes("CONTEXT_FIXTURE_782"), skill: request.includes("SKILL_DISCOVERY_782"), expanded: request.includes("SKILL_BODY_782"), extension: existsSync(join(f.cwd, "trust-sentinel")) };
      assert.deepEqual(observation, { context: true, skill: trust === "always", expanded: trust === "always", extension: trust === "always" });
      observations.push(observation); await agent.close();
    }
    assert.deepEqual(observations[1], observations[0]);
  });
}

test("raw / embedded execute native read, write, edit, bash and image read", async (t) => {
  const observations = [];
  const steps = [
    ["read", { path: "source.txt" }], ["write", { path: "output.txt", content: "Before edit\n" }],
    ["edit", { path: "output.txt", edits: [{ oldText: "Before", newText: "After" }] }],
    ["bash", { command: "cat output.txt" }], ["read", { path: "pixel.png" }],
  ];
  for (const kind of ["raw", "embedded"]) {
    const f = await fixture(t, { onChat({ response, index }) { if (index < steps.length) callTool(response, ...steps[index]); else answer(response, "Native tools finished"); } });
    writeFileSync(join(f.cwd, "source.txt"), "Native read marker\n");
    writeFileSync(join(f.cwd, "pixel.png"), Buffer.from(png, "base64"));
    const agent = await lane(f, kind);
    await agent.prompt("Use native coding tools"); await agent.settled();
    assert.equal(readFileSync(join(f.cwd, "output.txt"), "utf8"), "After edit\n");
    const results = agent.saved().messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, steps.length);
    assert.ok(results.every((m) => !m.isError), JSON.stringify(results));
    assert.ok(results.at(-1).content.some((part) => part.type === "image" && part.mimeType === "image/png"));
    assert.ok(JSON.stringify(f.gateway.requests.at(-1).body.messages).includes("data:image/png;base64,"));
    observations.push(results.map(({ toolName, content, isError }) => ({ toolName, content, isError })));
    await agent.close();
  }
  assert.deepEqual(observations[1], observations[0]);
});

test("raw guide / embedded native retry with untouched guide default settings", async (t) => {
  const results = [];
  for (const kind of ["raw", "embedded"]) {
    const f = await fixture(t, { onChat({ response, index }) {
      if (!index) response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Service unavailable, synthetic retry" } }));
      else answer(response, "Recovered using native retry");
    } });
    const settings = JSON.parse(readFileSync(join(f.runtime.agentDir, "settings.json"), "utf8"));
    assert.equal(settings.httpIdleTimeoutMs, 3900000);
    assert.deepEqual(settings.retry, { enabled: true, maxRetries: 20, provider: { timeoutMs: 3900000, maxRetries: 0 } });
    const agent = await lane(f, kind);
    await agent.prompt("Retry transient service error"); await agent.settled();
    await until(() => agent.saved().messages.some((m) => m.role === "assistant" && m.content.some((p) => p.text === "Recovered using native retry")), "native retry recovery persisted");
    assert.equal(f.gateway.requests.length, 2);
    results.push(messagesWithoutRuntimeMetadata(agent.saved().messages));
    await agent.close();
  }
  assert.deepEqual(results[1], results[0]);
});

test("raw guide / embedded manual compaction retries a transient summary failure and uses the native summary next turn", async (t) => {
  const results = [];
  for (const kind of ["raw", "embedded"]) {
    let summarize = false, summaryAttempts = 0;
    const f = await fixture(t, { onChat({ response }) {
      if (summarize && ++summaryAttempts === 1) response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Service unavailable during summary" } }));
      else answer(response, summarize ? "COMPACTION_SUMMARY_782" : "Detailed answer ".repeat(100));
    } }, { settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 4096 } } });
    const agent = await lane(f, kind);
    await agent.prompt("Older conversation ".repeat(100)); await agent.settled();
    await agent.prompt("Recent conversation ".repeat(100)); await agent.settled();
    summarize = true; await agent.compact(); summarize = false;
    const compact = agent.entries().findLast((entry) => entry.type === "compaction");
    assert.ok(compact, "Native compaction entry exists");
    assert.ok(summaryAttempts >= 2, "Native summary retry ran");
    assert.match(compact.summary, /COMPACTION_SUMMARY_782/);
    await agent.prompt("After summary"); await agent.settled();
    assert.match(JSON.stringify(f.gateway.requests.at(-1).body.messages), /COMPACTION_SUMMARY_782/);
    results.push({ summary: compact.summary, requests: f.gateway.requests.length });
    await agent.close();
  }
  assert.deepEqual(results[1], results[0]);
});

test("raw guide / embedded automatic threshold compaction continues with native context", async (t) => {
  const observations = [];
  for (const kind of ["raw", "embedded"]) {
    let heldSummary;
    const f = await fixture(t, { onChat({ response, index }) {
      if (index === 2) { heldSummary = response; return; }
      chunk(response, { role: "assistant", content: "Threshold answer ".repeat(100) });
      finish(response, { prompt_tokens: index === 1 ? 995000 : 10, completion_tokens: 4, total_tokens: index === 1 ? 995004 : 14 });
    } }, { settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16384 } } });
    const agent = await lane(f, kind);
    await agent.prompt("Older context ".repeat(100)); await agent.settled();
    const cursor = kind === "raw" ? agent.raw.child.messages.length : f.deltas().length;
    await agent.prompt("Cross the native threshold ".repeat(100));
    await until(() => heldSummary, "held automatic summary request");
    if (kind === "raw") assert.equal(agent.raw.child.messages.slice(cursor).some((event) => event.type === "agent_settled"), false);
    else assert.equal(f.deltas().slice(cursor).some((delta) => delta.kind === "turn.boundary"), false, "BB must not settle while native compaction is still running");
    assert.equal(agent.entries().some((entry) => entry.type === "compaction"), false);
    answer(heldSummary, "AUTO_COMPACTION_782");
    await agent.settled();
    assert.ok(agent.entries().some((entry) => entry.type === "compaction"), "Automatic summary is persisted before settlement");
    await agent.prompt("After automatic summary"); await agent.settled();
    assert.match(JSON.stringify(f.gateway.requests.at(-1).body.messages), /AUTO_COMPACTION_782/);
    observations.push({ requests: f.gateway.requests.length, summary: agent.entries().findLast((entry) => entry.type === "compaction").summary });
    await agent.close();
  }
  assert.deepEqual(observations[1], observations[0]);
});

test("raw native SessionManager / embedded checkpoint fork preserves the source and excludes later history", async (t) => {
  const observations = [];
  for (const kind of ["raw", "embedded"]) {
    const f = await fixture(t);
    const agent = await lane(f, kind);
    await agent.prompt("Before checkpoint marker"); const completion = await agent.settled();
    const checkpoint = kind === "raw"
      ? agent.entries().findLast((entry) => entry.type === "message" && entry.message.role === "assistant").id
      : completion.providerCheckpointId;
    assert.ok(checkpoint, "The public completed event must publish a fork checkpoint");
    await agent.prompt("AFTER_CHECKPOINT_MUST_BE_EXCLUDED"); await agent.settled();
    const sourceId = kind === "embedded" ? f.current.providerThreadId : undefined;
    await agent.close();
    const source = readFileSync(agent.path, "utf8");
    let fork;
    if (kind === "raw") {
      const forkPath = SessionManager.open(agent.path).createBranchedSession(checkpoint);
      assert.ok(forkPath);
      fork = await f.raw({ sessionFile: forkPath });
      await fork.prompt("Fork continuation"); await fork.settled();
    } else {
      await assert.rejects(f.rpc("thread/fork", { threadId: "thr_invalid_checkpoint", cwd: f.cwd, sourceProviderThreadId: sourceId, sourceProviderCheckpointId: "missing-native-checkpoint", options, instructionMode: "append" }));
      assert.equal(readFileSync(agent.path, "utf8"), source);
      const { result } = await f.rpc("thread/fork", { threadId: "thr_checkpoint_fork", cwd: f.cwd, sourceProviderThreadId: sourceId, sourceProviderCheckpointId: checkpoint, options, instructionMode: "append" });
      await f.resume(result.providerThreadId);
      await f.turn("Fork continuation"); await f.boundary();
    }
    const body = JSON.stringify(f.gateway.requests.at(-1).body.messages);
    assert.match(body, /Before checkpoint marker/);
    assert.doesNotMatch(body, /AFTER_CHECKPOINT_MUST_BE_EXCLUDED/);
    assert.equal(readFileSync(agent.path, "utf8"), source);
    observations.push({ before: body.includes("Before checkpoint marker"), after: body.includes("AFTER_CHECKPOINT_MUST_BE_EXCLUDED") });
    if (fork) await fork.child.close();
  }
  assert.deepEqual(observations[1], observations[0]);
});

for (const failed of [false, true]) {
  test(`raw native extension / embedded BB dynamic tool preserves rich ${failed ? "failure" : "success"}`, async (t) => {
    const observations = [];
    for (const kind of ["raw", "embedded"]) {
      const { dynamicTool } = await import("./bridge-fixture.mjs");
      const f = await fixture(t, { onChat({ response, index }) { if (!index) callTool(response); else answer(response); } });
      const content = [{ type: "text", text: "Rich prefix" }, { type: "image", mimeType: "image/png", data: png }, { type: "text", text: "Rich suffix" }];
      let agent;
      if (kind === "raw") {
        const extension = join(f.root, "dynamic-reference.mjs");
        writeFileSync(extension, `export default function(pi) {
          pi.registerTool({name:${JSON.stringify(dynamicTool.name)},label:"lookup",description:${JSON.stringify(dynamicTool.description)},parameters:${JSON.stringify(dynamicTool.inputSchema)},execute:async()=>({content:${JSON.stringify(content)}})});
          pi.on("tool_result", event => event.toolName === ${JSON.stringify(dynamicTool.name)} ? {isError:${failed}} : undefined);
        }`);
        const raw = await f.raw({ extraArgs: ["--extension", extension] });
        agent = { prompt: raw.prompt, settled: raw.settled, saved: raw.saved, close: () => raw.child.close() };
      } else {
        await f.start({ dynamicTools: [dynamicTool] });
        agent = { prompt: f.turn, settled: f.boundary, saved: f.saved, close: () => f.stop("release") };
      }
      await agent.prompt("Run dynamic lookup");
      if (kind === "embedded") {
        const call = await f.toolCall();
        assert.equal(call.params.tool, dynamicTool.name);
        assert.deepEqual(call.params.arguments, { value: "fixture" });
        f.reply(call.id, { success: !failed, contentItems: [{ type: "inputText", text: content[0].text }, { type: "inputImage", imageUrl: `data:image/png;base64,${png}` }, { type: "inputText", text: content[2].text }] });
      }
      await agent.settled();
      if (kind === "embedded") {
        const close = f.deltas().find((delta) => delta.kind === "item.close" && delta.item?.type === "tool");
        assert.equal(close.status, failed ? "failed" : "completed");
        assert.match(close.resultText, /Rich prefix[\s\S]*Rich suffix/);
      }
      const result = agent.saved().messages.find((message) => message.role === "toolResult");
      assert.equal(result.isError, failed);
      assert.deepEqual(result.content, content);
      assert.equal(f.gateway.requests.length, 2);
      const messages = f.gateway.requests[1].body.messages;
      const toolIndex = messages.findIndex((message) => message.role === "tool");
      assert.equal(messages[toolIndex].content, "Rich prefix\nRich suffix");
      assert.ok(JSON.stringify(messages[toolIndex + 1]).includes(png));
      observations.push({ content: result.content, isError: result.isError, next: f.gateway.requests[1].body.messages.filter((m) => m.role === "tool" || (m.role === "user" && JSON.stringify(m).includes("data:image/png"))) });
      await agent.close();
    }
    assert.deepEqual(observations[1], observations[0]);
  });
}

test("raw / embedded nested tool schema preserves unions and native argument validation", async (t) => {
  const tool = {
    name: "nested_lookup", description: "Look up structured selectors.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["target"],
      properties: { target: {
        type: "object", additionalProperties: false, required: ["mode", "selectors"],
        properties: {
          mode: { type: "string", enum: ["read", "write"] },
          selectors: { type: "array", minItems: 1, items: { oneOf: [
            { type: "object", additionalProperties: false, required: ["field", "value"], properties: { field: { const: "name" }, value: { type: "string", pattern: "^[a-z]+$" } } },
            { type: "object", additionalProperties: false, required: ["field", "value"], properties: { field: { const: "line" }, value: { type: "integer", minimum: 1 } } },
          ] } },
        },
      } },
    },
  };
  const valid = { target: { mode: "read", selectors: [{ field: "line", value: 7 }, { field: "name", value: "alpha" }] } };
  const invalid = { target: { mode: "not-an-enum-member", selectors: [{ field: "line", value: 0 }] } };
  const observations = [];
  for (const kind of ["raw", "embedded"]) {
    const f = await fixture(t, { onChat({ response, index }) {
      if (index < 2) callTool(response, tool.name, index === 0 ? invalid : valid);
      else answer(response);
    } });
    let raw;
    if (kind === "raw") {
      const extension = join(f.root, "nested-reference.mjs");
      writeFileSync(extension, `export default function(pi) {
        pi.registerTool({ name: ${JSON.stringify(tool.name)}, label: "lookup", description: ${JSON.stringify(tool.description)}, parameters: ${JSON.stringify(tool.inputSchema)},
          execute: async (_id, args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }) });
      }`);
      raw = await f.raw({ extraArgs: ["--extension", extension] });
      await raw.prompt("Validate nested selectors"); await raw.settled();
    } else {
      await f.start({ dynamicTools: [tool] }); await f.turn("Validate nested selectors");
      const call = await f.toolCall();
      assert.deepEqual(call.params.arguments, valid, "Invalid nested input must not reach the BB tool");
      assert.equal(f.gateway.requests.length, 2, "Native validation rejected the first call");
      f.reply(call.id, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(call.params.arguments) }] });
      assert.equal((await f.boundary()).status, "completed");
      assert.equal(f.messages.filter((message) => message.method === "item/tool/call").length, 1);
    }
    const results = (raw ? raw.saved() : f.saved()).messages.filter((message) => message.role === "toolResult" && message.toolName === tool.name);
    assert.deepEqual(results.map((result) => result.isError), [true, false]);
    assert.match(JSON.stringify(results[0].content), /Validation failed/);
    assert.equal(results[1].content[0].text, JSON.stringify(valid));
    const schema = f.gateway.requests[0].body.tools.find((entry) => entry.function.name === tool.name).function.parameters;
    assert.deepEqual(schema.properties.target.properties.selectors.items.oneOf, tool.inputSchema.properties.target.properties.selectors.items.oneOf);
    observations.push({ schema, result: results[1].content });
    if (raw) await raw.child.close(); else await f.stop("release");
  }
  assert.deepEqual(observations[1], observations[0]);
});

test("raw / embedded native setters keep one child and preserve model and thinking across restart", async (t) => {
  const observations = [];
  for (const kind of ["raw", "embedded"]) {
    const f = await fixture(t, {}, { traceChildren: kind === "embedded" });
    let raw;
    if (kind === "raw") {
      raw = await f.raw(); await raw.prompt("Initial model"); await raw.settled();
      await raw.rpc("set_model", { provider: "vrata.tg", modelId: models.responses });
      await raw.rpc("set_thinking_level", { level: "high" });
      await raw.prompt("Explicit selection"); await raw.settled();
      const path = raw.sessionFile; await raw.child.close();
      raw = await f.raw({ sessionFile: path, model: null, thinking: null });
      await raw.prompt("Restored selection"); await raw.settled();
    } else {
      const { providerThreadId } = await f.start();
      await f.turn("Initial model"); await f.boundary();
      assert.equal(f.spawned().length, 1);
      const pid = f.spawned()[0].pid;
      await f.turn("Explicit selection", { model: models.responses, reasoningLevel: "high" }); await f.boundary();
      assert.deepEqual(f.spawned().map((child) => child.pid), [pid]);
      assert.equal(f.gateway.requests[1].path, "/v1/responses");
      assert.equal(f.gateway.requests[1].body.reasoning.effort, "high");
      assert.equal(f.saved().model.modelId, models.responses);
      assert.equal(f.saved().thinkingLevel, "high");
      await f.restart(); await f.resume(providerThreadId);
      await f.turn("Restored selection", { model: undefined, reasoningLevel: undefined }); await f.boundary();
      assert.equal(f.saved().model.modelId, models.responses);
      assert.equal(f.saved().thinkingLevel, "high");
    }
    const request = f.gateway.requests.at(-1).body;
    assert.equal(request.model, models.responses);
    assert.equal(request.reasoning.effort, "high");
    assert.match(JSON.stringify(request.input), /Explicit selection/);
    observations.push({ model: request.model, reasoning: request.reasoning, history: request.input.filter((m) => m.role === "user") });
    if (raw) await raw.child.close(); else await f.stop("release");
  }
  assert.deepEqual(observations[1], observations[0]);
});

test("raw guide / embedded context overflow recovers through native compaction and retry", async (t) => {
  const observations = [];
  for (const kind of ["raw", "embedded"]) {
    const f = await fixture(t, { onChat({ response, index }) {
      if (index === 0) answer(response, "Older answer ".repeat(200));
      else if (index === 1) response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "This model's maximum context length is 1000000 tokens. However, your messages resulted in 1000100 tokens.", code: "context_length_exceeded" } }));
      else if (index === 2) answer(response, "OVERFLOW_SUMMARY_782");
      else answer(response, "RECOVERED_OVERFLOW_782");
    } }, { settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 4096 } } });
    const agent = await lane(f, kind);
    await agent.prompt("Older context ".repeat(200)); await agent.settled();
    await agent.prompt("Cause one controlled context rejection"); await agent.settled();
    await until(() => agent.saved().messages.some((m) => m.role === "assistant" && m.content.some((p) => p.text === "RECOVERED_OVERFLOW_782")), "native overflow recovery", 30000);
    const compact = agent.entries().findLast((entry) => entry.type === "compaction");
    assert.ok(compact, "Native overflow compaction was persisted");
    assert.match(compact.summary, /OVERFLOW_SUMMARY_782/);
    assert.match(JSON.stringify(f.gateway.requests.at(-1).body.messages), /OVERFLOW_SUMMARY_782/);
    observations.push({ requests: f.gateway.requests.length, summary: compact.summary, answer: agent.saved().messages.findLast((m) => m.role === "assistant").content });
    await agent.close();
  }
  assert.deepEqual(observations[1], observations[0]);
});
