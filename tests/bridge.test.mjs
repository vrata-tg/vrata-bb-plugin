import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "../dist/host.js";
import { dynamicModel, fixture, models, sleep } from "./bridge-fixture.mjs";

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

test("first caller flow acknowledges start and turn before key/model forms, prompts once", async (t) => {
  const f = await fixture(t, {}, { configured: false });
  await f.start({ options: { model: "vrata-setup" } });
  assert.equal(f.messages.some((m) => m.method === "interaction/request"), false);
  const turn = await f.turn("Original setup input", { model: "vrata-setup" });
  const key = await f.interaction("vrata/api-key");
  assert.ok(f.messages.findIndex((m) => m.id === turn.id) < f.messages.indexOf(key));
  await saveLocalCredentials(t, f);
  f.reply(key.id, { kind: "request_answer", value: { configured: true } });
  const model = await f.interaction("vrata/model");
  const choices = model.params.payload.data.models;
  assert.ok(choices.some((choice) => choice.id === models.chat));
  assert.ok(choices.some((choice) => choice.id === dynamicModel), "onboarding omitted the server-only model");
  f.reply(model.id, { kind: "request_answer", value: { modelId: dynamicModel, reasoningLevel: "high" } });
  assert.equal((await f.boundary()).status, "completed");
  assert.equal(f.gateway.requests.length, 1);
  assert.equal(f.gateway.requests[0].body.model, dynamicModel);
  assert.equal(f.gateway.requests[0].path, "/v1/responses");
  assert.equal(f.gateway.requests[0].body.reasoning.effort, "high");
  assert.equal(f.gateway.requests[0].body.input.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("Original setup input")).length, 1);
  assert.equal(f.deltas().filter((d) => d.kind === "input.accepted").length, 1);
});

test("Stop during onboarding rejects a late form reply without starting Pi generation", async (t) => {
  const f = await fixture(t, {}, { configured: false });
  await f.start({ options: { model: "vrata-setup" } });
  await f.turn("Do not run after Stop", { model: "vrata-setup" });
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
