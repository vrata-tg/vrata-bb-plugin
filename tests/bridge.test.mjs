import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "../dist/host.js";
import { answer, callTool, chunk, dynamicModel, dynamicTool, fixture, models, responsesAnswer, sleep } from "./bridge-fixture.mjs";

test("GPT reasoning levels survive discovery, dispatch and session persistence", async (t) => {
  for (const model of ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]) await t.test(model, async (t) => {
    const f = await fixture(t, {
      onModels({ response }) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: model }] }));
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

test("GLM reasoning and tool results survive native Chat transport", async (t) => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) await t.test(model, async (t) => {
    const f = await fixture(t, {
      onModels({ response }) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: model }] }));
      },
      onChat({ response, body, index }) {
        assert.equal(body.reasoning_effort, index < 2 ? "high" : "none");
        if (index === 0) {
          chunk(response, { role: "assistant", reasoning_content: "Inspect the supplied value first." });
          callTool(response);
        } else {
          assert.ok(body.messages.some((message) => message.role === "tool" && message.content === "GLM_TOOL_RESULT"));
          answer(response, "GLM_TOOL_RESULT");
        }
      },
    });
    await f.start({ dynamicTools: [dynamicTool], options: { model, reasoningLevel: "high" } });
    await f.turn("Look up the value", { model, reasoningLevel: "high" });
    const call = await f.toolCall();
    f.reply(call.id, { success: true, contentItems: [{ type: "inputText", text: "GLM_TOOL_RESULT" }] });
    assert.equal((await f.boundary()).status, "completed");
    assert.ok(f.events().some((event) => event.type === "item/reasoning/textDelta" && event.delta === "Inspect the supplied value first."));
    assert.ok(f.saved().messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "thinking" && part.thinking === "Inspect the supplied value first.")));
    assert.equal(f.gateway.requests.length, 2);
    await f.turn("Disable extended thinking", { model, reasoningLevel: "none" });
    assert.equal((await f.boundary()).status, "completed");
    assert.equal(f.saved().thinkingLevel, "off");
    assert.equal(f.gateway.requests.length, 3);
  });
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
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "gpt-next-account" }] }));
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
