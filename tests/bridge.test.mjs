import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "../dist/host.js";
import { dynamicModel, dynamicTool, fixture, models, responsesAnswer, sleep } from "./bridge-fixture.mjs";

test("Opus High preserves thinking text and token usage through the embedded bridge", async (t) => {
  const model = "claude-opus-5-5";
  const f = await fixture(t, {
    onModels({ request, response }) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: request.headers["anthropic-version"] ? [{ id: model, gateway_metadata: {
          protocol: "anthropic", verified_transport: "messages", supports_reasoning: true,
          reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
          max_input_tokens: 1_000_000, max_output_tokens: 128_000,
        } }] : [],
      }));
    },
    onAnthropic({ response }) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "message_start", message: { id: "msg-opus", type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the available tools." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Tools are available." } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 5 } } },
        { type: "message_stop" },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    },
  });
  await f.start({ dynamicTools: [dynamicTool], options: { model, reasoningLevel: "high" } });
  await f.turn("Check Opus thinking", { model, reasoningLevel: "high" });
  assert.equal((await f.boundary()).status, "completed");
  const body = f.gateway.requests[0].body;
  assert.equal(body.thinking.type, "adaptive");
  assert.equal(body.thinking.display, "summarized");
  assert.equal(body.output_config.effort, "high");
  assert.ok(["read", "write", "edit", "bash", dynamicTool.name].every((name) => body.tools.some((tool) => tool.name === name)));
  const thinking = f.events().filter((event) => event.type === "item/reasoning/textDelta").map((event) => event.delta).join("");
  assert.equal(thinking, "Check the available tools.");
  const saved = f.saved();
  assert.equal(saved.thinkingLevel, "high");
  const assistant = saved.messages.findLast((message) => message.role === "assistant");
  assert.equal(assistant.content.find((block) => block.type === "thinking").thinking, thinking);
  assert.equal(assistant.usage.reasoning, 5);
  const usage = f.events().findLast((event) => event.type === "thread/tokenUsage/updated").tokenUsage;
  assert.equal(usage.last.reasoningOutputTokens, 5);
  assert.equal(usage.total.reasoningOutputTokens, 5);
  assert.equal(usage.last.outputTokens, 9);
  assert.equal(usage.last.totalTokens, 19);
});

test("new model names use catalog transports through native Pi and persist selection", async (t) => {
  for (const [transport, path] of [["chat_completions", "/v1/chat/completions"], ["responses", "/v1/responses"], ["messages", "/v1/messages"]]) {
    await t.test(transport, async (t) => {
      const model = `brand-new-${transport}`;
      const protocol = transport === "messages" ? "anthropic" : "openai";
      const f = await fixture(t, {
        onModels({ request, response }) {
          const requested = request.headers["anthropic-version"] ? "anthropic" : "openai";
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: requested === protocol ? [{
            id: model, gateway_metadata: { protocol, verified_transport: transport, supports_tools: true,
              max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
          }] : [] }));
        },
      });
      await f.start({ dynamicTools: [dynamicTool], options: { model, reasoningLevel: "high" } });
      await f.turn("Use the server catalog", { model, reasoningLevel: "high" });
      assert.equal((await f.boundary()).status, "completed");
      const request = f.gateway.requests[0];
      assert.equal(request.path, path);
      assert.equal(request.body.model, model);
      assert.ok(request.body.tools.length > 0);
      assert.equal(f.saved().model.modelId, model);
      assert.equal(f.saved().thinkingLevel, "high");
      if (transport === "chat_completions") {
        await f.turn("Disable extended thinking", { model, reasoningLevel: "none" });
        assert.equal((await f.boundary()).status, "completed");
        assert.equal(f.gateway.requests.at(-1).body.reasoning_effort, "none");
        assert.equal(f.saved().thinkingLevel, "off");
      }
    });
  }
});

test("GPT reasoning levels survive discovery, dispatch and session persistence", async (t) => {
  for (const model of ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]) await t.test(model, async (t) => {
    const f = await fixture(t, {
      onModels({ request, response }) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: request.headers["anthropic-version"] ? [] : [{
          id: model, gateway_metadata: { max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
        }] }));
      },
      onResponses({ response }) { responsesAnswer(response); },
    });
    const catalog = (await f.rpc("model/list", {})).result.models;
    const levels = catalog.find(({ id }) => id === model).supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort);
    assert.equal(levels.includes("none"), model === "gpt-6-luna");
    assert.ok(levels.includes("xhigh") && levels.includes("max"));
    await f.start({ options: { model, reasoningLevel: "high" } });
    for (const reasoningLevel of ["xhigh", "max"]) {
      await f.turn("Preserve the selected reasoning level", { model, reasoningLevel });
      assert.equal((await f.boundary()).status, "completed");
      assert.equal(f.gateway.requests.at(-1).body.reasoning.effort, reasoningLevel);
      assert.equal(f.saved().thinkingLevel, reasoningLevel);
    }
  });
});

test("models without selectable efforts accept the BB default without inventing native none", async (t) => {
  for (const [transport, path, model = "no-selectable-effort"] of [
    ["chat_completions", "/v1/chat/completions"], ["responses", "/v1/responses"],
    ["messages", "/v1/messages"], ["messages", "/v1/messages", "claude-sonnet-5-5"],
  ]) {
    for (const capability of [{ supports_reasoning: false }, { reasoning_levels: [] }]) {
      await t.test(`${transport}/${model}/${Object.keys(capability)[0]}`, async (t) => {
        const protocol = transport === "messages" ? "anthropic" : "openai";
        const f = await fixture(t, {
          onModels({ request, response }) {
            const requested = request.headers["anthropic-version"] ? "anthropic" : "openai";
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: requested === protocol ? [{
              id: model, gateway_metadata: { protocol, verified_transport: transport,
                max_input_tokens: 1_000_000, max_output_tokens: 128_000, ...capability },
            }] : [] }));
          },
        });
        const advertised = (await f.rpc("model/list", {})).result.models[0];
        assert.deepEqual(advertised.supportedReasoningEfforts, []);
        assert.equal(advertised.defaultReasoningEffort, "none");
        await f.start({ options: { model: undefined, reasoningLevel: advertised.defaultReasoningEffort } });
        for (let turn = 0; turn < 2; turn++) {
          await f.turn("Use the model default", { model, reasoningLevel: "none" });
          assert.equal((await f.boundary()).status, "completed");
          const { path: actualPath, body } = f.gateway.requests.at(-1);
          assert.equal(actualPath, path);
          assert.equal(body.reasoning_effort, undefined);
          assert.equal(body.reasoning, undefined);
          assert.equal(body.output_config?.effort, undefined);
          assert.ok(body.messages?.every((message) => message.output_config?.effort === undefined) ?? true);
          assert.ok(body.thinking === undefined || body.thinking.type === "disabled");
        }
      });
    }
  }
});

async function saveLocalCredentials(t, f) {
  const harness = experimental_createHostEntryHarness(host, {
    experimental_paths: { dataDir: join(f.root, "host-data"), tempDir: join(f.root, "temp") },
  });
  t.after(() => harness.experimental_dispose());
  const metadata = await harness.experimental_call("saveCredentials", { apiKey: "synthetic-key-a", baseUrl: f.gateway.url });
  assert.equal(metadata.configured, true);
  assert.equal(JSON.stringify(metadata).includes("synthetic-key-a"), false);
  assert.ok(f.gateway.catalogRequests.length > 0, "Save validates on the execution host");
  assert.equal(f.gateway.requests.length, 0, "Credential validation cannot generate a response");
}

test("native public catalog routes bare IDs through the registered Vrata provider", async (t) => {
  const f = await fixture(t, {}, { traceChildren: true });
  const { result } = await f.rpc("model/list", { cwd: f.cwd });
  assert.ok(result.models.some((model) => model.id === models.chat));
  assert.ok(result.models.some((model) => model.id === dynamicModel), "server-only model was omitted from the catalog");
  assert.ok(result.models.every((model) => !model.id.includes("/")));
  assert.ok(result.models.every((model) => model.routeProviderId === "vrata"));
  assert.equal(f.gateway.requests.length, 0, "Discovery cannot generate a model response");
  assert.deepEqual(f.spawned(), [], "Catalog metadata needs no Pi child");
  await f.start({ options: { model: dynamicModel, reasoningLevel: "high" } });
  await f.turn("Bare server model ID reaches native Pi", { model: dynamicModel, reasoningLevel: "high" });
  assert.equal((await f.boundary()).status, "completed");
  assert.equal(f.gateway.requests[0].body.model, dynamicModel);
  assert.equal(f.gateway.requests[0].path, "/v1/responses");
  assert.equal(f.spawned().length, 1, "The witness observes the actual session child");
});

test("key onboarding preserves the native model choice and prompts once without a model form", async (t) => {
  for (const pluginId of ["vrata", "bb-plugin"]) await t.test(pluginId, async (t) => {
    const f = await fixture(t, {}, { configured: false, pluginId });
    await f.start({ options: { model: dynamicModel, reasoningLevel: "high" } });
    assert.equal(f.messages.some((m) => m.method === "interaction/request"), false);
    const turn = await f.turn("Original setup input", { model: dynamicModel, reasoningLevel: "high" });
    const key = await f.interaction(`${pluginId}/api-key`);
    assert.ok(f.messages.findIndex((m) => m.id === turn.id) < f.messages.indexOf(key));
    await saveLocalCredentials(t, f);
    f.reply(key.id, { kind: "request_answer", value: { configured: true } });
    assert.equal((await f.boundary()).status, "completed");
    assert.equal(f.messages.filter((m) => m.method === "interaction/request").length, 1);
    assert.equal(f.gateway.requests.length, 1);
    assert.equal(f.gateway.requests[0].body.model, dynamicModel);
    assert.equal(f.gateway.requests[0].path, "/v1/responses");
    assert.equal(f.gateway.requests[0].body.reasoning.effort, "high");
    assert.equal(f.gateway.requests[0].body.input.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("Original setup input")).length, 1);
    assert.equal(f.deltas().filter((d) => d.kind === "input.accepted").length, 1);
  });
});

test("native catalog reflects host key save, rotation and deletion without a setup model or generation", async (t) => {
  const f = await fixture(t, {}, { configured: false, traceChildren: true });
  assert.deepEqual((await f.rpc("model/list", {})).result, { models: [], selectedOnlyModels: [] });
  await saveLocalCredentials(t, f);
  const catalog = (await f.rpc("model/list", {})).result;
  assert.ok(catalog.models.some(({ id }) => id === dynamicModel));
  const high = catalog.models.find(({ id }) => id === dynamicModel);
  assert.ok(high.supportedReasoningEfforts.some(({ reasoningEffort }) => reasoningEffort === "high"));
  const next = await f.anotherGateway({ onModels({ response }) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{
      id: "gpt-next-account", gateway_metadata: { max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
    }] }));
  } });
  f.configure(next, "synthetic-key-b");
  assert.deepEqual((await f.rpc("model/list", {})).result.models.map(({ id }) => id), ["gpt-next-account"]);
  unlinkSync(join(f.dataDir, "credentials.json"));
  assert.deepEqual((await f.rpc("model/list", {})).result, { models: [], selectedOnlyModels: [] });
  assert.equal(f.gateway.requests.length + next.requests.length, 0);
  assert.deepEqual(f.spawned(), []);
});

test("Stop during onboarding rejects a late form reply without starting Pi generation", async (t) => {
  const f = await fixture(t, {}, { configured: false });
  await f.start({ options: { model: dynamicModel } });
  await f.turn("Do not run after Stop", { model: dynamicModel });
  const key = await f.interaction("vrata/api-key");
  const stopped = await f.stop();
  const terminal = f.records().find(({ event }) => event.type === "turn/completed" && event.status === "interrupted");
  assert.ok(terminal && terminal.logIndex < f.messages.findIndex((m) => m.id === stopped.id));
  await saveLocalCredentials(t, f);
  const count = f.messages.length;
  f.reply(key.id, { kind: "request_answer", value: { configured: true } });
  await f.rpc("provider/health", { providerId: "vrata", cwd: f.cwd });
  await sleep(50);
  assert.equal(f.gateway.requests.length, 0);
  assert.equal(f.messages.slice(count).some((m) => m.method === "interaction/request" || m.method === "thread/delta"), false);
});
