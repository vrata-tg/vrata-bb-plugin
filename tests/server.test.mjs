import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../dist/server.js";

const draft = { apiKey: "synthetic-key-a", baseUrl: "http://127.0.0.1:19001" };
const threadTarget = { kind: "thread", threadId: "waiting-thread" };
const hostTarget = { kind: "host", hostId: "target" };
const configured = { configured: true, baseUrl: `${draft.baseUrl}/v1` };

function serverMock(t, {
  call = async (method) => method === "balance" ? { status: "unconfigured" }
    : method === "deleteCredentials" ? { configured: false, baseUrl: "https://api.vrata.tg" } : configured,
  environmentId = "thread-environment",
  reloadConfig = async () => {},
  interaction = { id: "setup", threadId: "waiting-thread", status: "pending", providerId: "vrata", payload: { kind: "bb-plugin/api-key", data: {} } },
} = {}) {
  const methods = new Map();
  const routes = new Map();
  const disposers = [];
  const calls = [];
  const lookups = [];
  const interactionAnswers = [];
  const machines = [
    { id: "target", name: "Thread machine", status: "connected" },
    { id: "other", name: "Other machine", status: "disconnected" },
  ];
  let registrations = 0;
  let providerDisposals = 0;
  const pickerRefreshes = [];
  const dispose = () => { for (const disposer of disposers.splice(0).reverse()) disposer(); };
  const bb = {
    pluginId: "bb-plugin",
    get settings() { throw new Error("Legacy central settings must remain inert"); },
    get background() { throw new Error("Credential synchronization must not run"); },
    hosts: {
      experimental_client: ({ contract }) => ({
        async call(method, input, { hostId, signal }) {
          input = contract[method].input.parse(input);
          calls.push({ method, input, hostId, signal });
          return contract[method].output.parse(await call(method, input, { hostId, signal }));
        },
      }),
    },
    sdk: {
      subscribe: () => () => {},
      system: { reloadConfig: async () => { pickerRefreshes.push(registrations); await reloadConfig(); return { ok: true }; } },
      hosts: {
        list: async () => machines,
        get: async ({ hostId }) => {
          lookups.push(["host", hostId]);
          const machine = machines.find(({ id }) => id === hostId);
          if (!machine) throw new Error(`${draft.apiKey}: private lookup detail`);
          return machine;
        },
      },
      threads: {
        get: async ({ threadId }) => { lookups.push(["thread", threadId]); return { environmentId }; },
        stop: async ({ threadId }) => { interactionAnswers.push({ threadId, stopped: true }); },
        interactions: {
          get: async () => interaction,
          respond: async (input) => { interactionAnswers.push(input); },
        },
      },
      environments: { get: async ({ environmentId }) => { lookups.push(["environment", environmentId]); return { hostId: "target" }; } },
    },
    rpc: { register: (contract, handlers) => {
      for (const [name, handler] of Object.entries(handlers)) methods.set(name, { handler, schema: contract[name] });
    } },
    providers: { register: () => { registrations++; return { dispose() { providerDisposals++; } }; } },
    events: { on() {} },
    http: { route: (method, path, handler) => routes.set(`${method} ${path}`, handler) },
    onDispose: (callback) => disposers.push(callback),
  };
  plugin(bb);
  t.after(dispose);
  return {
    calls, lookups, machines, dispose, interactionAnswers, pickerRefreshes,
    get registrations() { return registrations; },
    get providerDisposals() { return providerDisposals; },
    async rpc(name, input) {
      const { handler, schema } = methods.get(name);
      return schema.output.parse(await handler(schema.input.parse(input)));
    },
    subscribe() {
      const controller = new AbortController();
      const response = routes.get("GET /balance-events")({ req: { raw: { signal: controller.signal } } });
      t.after(() => controller.abort());
      return { reader: response.body.getReader(), close: () => controller.abort() };
    },
  };
}

const safeError = (error) => {
  assert.doesNotMatch(error.message, /synthetic-key|private .* detail/);
  return true;
};

test("registration and host listing never read central settings or contact a host", async (t) => {
  const mock = serverMock(t);
  assert.deepEqual(await mock.rpc("listHosts", null), mock.machines);
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(mock.lookups, []);
  assert.equal(mock.registrations, 1);
  assert.deepEqual(mock.pickerRefreshes, []);
});

test("onboarding resolves thread → environment → host and rejects an app-supplied override", async (t) => {
  const mock = serverMock(t);
  await assert.rejects(mock.rpc("saveCredentials", { ...draft, target: { ...threadTarget, hostId: "other" } }));
  assert.equal(mock.calls.length, 0);
  const result = await mock.rpc("saveCredentials", { ...draft, target: threadTarget });
  assert.deepEqual(result, { ...configured, hostId: "target", hostName: "Thread machine" });
  assert.deepEqual(mock.lookups, [["thread", "waiting-thread"], ["environment", "thread-environment"], ["host", "target"]]);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual({ ...mock.calls[0], signal: undefined }, { method: "saveCredentials", input: draft, hostId: "target", signal: undefined });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key|apiKey/);
  assert.equal(mock.registrations, 2);
  assert.equal(mock.providerDisposals, 1);
  assert.deepEqual(mock.pickerRefreshes, [2]);
});

test("target failure never falls back to another working host or exposes host errors", async (t) => {
  const mock = serverMock(t, { call: async (_method, _input, { hostId }) => {
    if (hostId === "target") throw new Error(`${draft.apiKey}: private host detail`);
    return configured;
  } });
  await mock.rpc("getConfiguration", { target: { kind: "host", hostId: "other" } });
  mock.calls.length = 0;
  await assert.rejects(mock.rpc("saveCredentials", { ...draft, target: threadTarget }), safeError);
  assert.deepEqual(mock.calls.map(({ hostId }) => hostId), ["target"]);
  assert.equal(mock.registrations, 1);
});

test("configured:false, absent environment and unknown host cannot acknowledge setup", async (t) => {
  const falseAck = serverMock(t, { call: async () => ({ ...configured, configured: false }) });
  await assert.rejects(falseAck.rpc("saveCredentials", { ...draft, target: threadTarget }), safeError);
  assert.equal(falseAck.registrations, 1);
  const noEnvironment = serverMock(t, { environmentId: null });
  await assert.rejects(noEnvironment.rpc("saveCredentials", { ...draft, target: threadTarget }), safeError);
  await assert.rejects(noEnvironment.rpc("getConfiguration", { target: { kind: "host", hostId: "unknown" } }), safeError);
  assert.equal(noEnvironment.calls.length, 0);
});

test("read, balance and delete use only the explicit host; only mutations invalidate", async (t) => {
  const mock = serverMock(t);
  const subscription = mock.subscribe();
  const next = async () => new TextDecoder().decode((await subscription.reader.read()).value);
  assert.equal(await next(), "data: refresh\n\n");
  assert.deepEqual(await mock.rpc("getConfiguration", { target: hostTarget }), { ...configured, hostId: "target", hostName: "Thread machine" });
  assert.deepEqual(await mock.rpc("balance", { hostId: "target" }), { status: "unconfigured" });
  await assert.rejects(mock.rpc("balance", null));
  await mock.rpc("saveCredentials", { ...draft, target: hostTarget });
  assert.equal(await next(), "data: refresh\n\n");
  assert.deepEqual(await mock.rpc("deleteCredentials", { hostId: "target" }), {
    hostId: "target", hostName: "Thread machine", configured: false, baseUrl: "https://api.vrata.tg",
  });
  assert.equal(await next(), "data: refresh\n\n");
  assert.deepEqual(mock.calls.map(({ method, hostId }) => [method, hostId]), [
    ["getConfiguration", "target"], ["balance", "target"], ["saveCredentials", "target"], ["deleteCredentials", "target"],
  ]);
  assert.equal(mock.registrations, 3);
  assert.equal(mock.providerDisposals, 2);
  assert.deepEqual(mock.pickerRefreshes, [2, 3]);
  subscription.close();
  assert.equal((await subscription.reader.read()).done, true);
});

test("server disposal aborts in-flight host validation and rejects a late acknowledgement", { timeout: 3000 }, async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const mock = serverMock(t, { call: async (_method, _input, { signal }) => {
    started.resolve(signal);
    await release.promise;
    return configured;
  } });
  const pending = assert.rejects(mock.rpc("saveCredentials", { ...draft, target: threadTarget }), safeError);
  const signal = await started.promise;
  mock.dispose();
  assert.equal(signal.aborted, true);
  release.resolve();
  await pending;
  assert.equal(mock.registrations, 1);
  await assert.rejects(mock.rpc("getConfiguration", { target: hostTarget }), safeError);
  assert.equal(mock.calls.length, 1);
});

test("unavailable balance returns a static error and never tries another host", async (t) => {
  const mock = serverMock(t, { call: async () => { throw new Error(`${draft.apiKey}: private balance detail`); } });
  const result = await mock.rpc("balance", { hostId: "target" });
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.message, /synthetic-key|private balance detail/);
  assert.deepEqual(mock.calls.map(({ hostId }) => hostId), ["target"]);
});

test("credential acknowledgement waits for picker refresh and rejects a late result after disposal", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const mock = serverMock(t, { reloadConfig: async () => { started.resolve(); await release.promise; } });
  const pending = assert.rejects(mock.rpc("saveCredentials", { ...draft, target: hostTarget }), safeError);
  await started.promise;
  mock.dispose();
  release.resolve();
  await pending;
});

test("setup page reads and answers only a pending interaction owned by this plugin and provider", async (t) => {
  const target = { threadId: "waiting-thread", interactionId: "setup" };
  const mock = serverMock(t);
  assert.deepEqual(await mock.rpc("getSetupInteraction", target), { id: "setup", kind: "api-key", data: {} });
  await mock.rpc("submitSetupInteraction", { ...target, answer: { kind: "api-key", configured: true } });
  assert.deepEqual(mock.interactionAnswers, [{ ...target, value: { configured: true } }]);
  await mock.rpc("submitSetupInteraction", { ...target, answer: { kind: "cancel" } });
  assert.deepEqual(mock.interactionAnswers[1], { threadId: target.threadId, stopped: true });
  for (const change of [
    { status: "resolved" }, { status: "cancelled" }, { threadId: "another-thread" },
    { providerId: "another-provider" }, { payload: { kind: "another-plugin/api-key", data: {} } },
  ]) {
    const other = serverMock(t, { interaction: { id: "setup", threadId: "waiting-thread", status: "pending", providerId: "vrata", payload: { kind: "bb-plugin/api-key", data: {} }, ...change } });
    await assert.rejects(other.rpc("getSetupInteraction", target));
    await assert.rejects(other.rpc("submitSetupInteraction", { ...target, answer: { kind: "api-key", configured: true } }));
    assert.deepEqual(other.interactionAnswers, []);
  }
  assert.equal(mock.interactionAnswers.length, 2);
});
