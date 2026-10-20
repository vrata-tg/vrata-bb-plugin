import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import plugin from "../dist/server.js";

const initialSettings = { apiKey: "synthetic-key-a", baseUrl: "http://127.0.0.1:19001" };
const nextSettings = { apiKey: "synthetic-key-b", baseUrl: "http://127.0.0.1:19002" };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function serverMock(t, {
  hosts = ["target", "other"],
  sync = async () => ({ configured: true }),
  readSettings = async (snapshot) => snapshot,
} = {}) {
  let values = { ...initialSettings };
  let settingsChanged;
  let hostContract;
  const methods = new Map();
  const disposers = [];
  const calls = [];
  const lookups = [];
  const warnings = [];
  const active = new Map();
  const maxActive = new Map();
  const written = new Map();
  const bb = {
    settings: {
      define: () => ({
        get: async () => readSettings({ ...values }),
        onChange: (callback) => { settingsChanged = callback; },
      }),
    },
    hosts: {
      experimental_client: ({ contract }) => {
        hostContract = contract;
        return {
          async call(method, input, { hostId }) {
            const snapshot = hostContract[method].input.parse(input);
            calls.push({ hostId, ...snapshot });
            active.set(hostId, (active.get(hostId) ?? 0) + 1);
            maxActive.set(hostId, Math.max(maxActive.get(hostId) ?? 0, active.get(hostId)));
            try {
              const result = hostContract[method].output.parse(await sync({ hostId, ...snapshot }));
              if (result.configured) written.set(hostId, snapshot);
              else written.delete(hostId);
              return result;
            } finally {
              active.set(hostId, active.get(hostId) - 1);
            }
          },
        };
      },
    },
    sdk: {
      hosts: { list: async () => hosts.map((id) => ({ id })) },
      threads: { get: async (args) => { lookups.push(args); return { environmentId: "thread-environment" }; } },
      environments: { get: async (args) => { lookups.push(args); return { hostId: "target" }; } },
    },
    rpc: {
      register: (contract, handlers) => {
        for (const [name, handler] of Object.entries(handlers)) methods.set(name, { handler, schema: contract[name] });
      },
    },
    providers: { register: () => ({ dispose() {} }) },
    background: { service() {} },
    events: { on() {} },
    http: { route() {} },
    log: { warn: (message) => warnings.push(message) },
    onDispose: (dispose) => disposers.push(dispose),
  };
  plugin(bb);
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  return {
    bb, calls, lookups, warnings, written, maxActive,
    changeSettings(next, notify = true) {
      const previous = values;
      values = { ...next };
      if (notify) settingsChanged(values, previous);
    },
    async waitForKey(input = { threadId: "waiting-thread" }) {
      const { handler, schema } = methods.get("waitForKey");
      return schema.output.parse(await handler(schema.input.parse(input)));
    },
    async validateKey(apiKey) {
      const { handler, schema } = methods.get("validateKey");
      return schema.output.parse(await handler(schema.input.parse({ apiKey })));
    },
  };
}

test("onboarding rejects target failure even when another host succeeds, without leaking host errors", async (t) => {
  const mock = serverMock(t, {
    sync: async ({ hostId, apiKey }) => {
      if (hostId === "target") throw new Error(`${apiKey}: private host detail`);
      return { configured: true };
    },
  });
  mock.changeSettings(initialSettings);
  await settle();
  assert.deepEqual(mock.written.get("other"), initialSettings);
  await assert.rejects(mock.waitForKey(), (error) => {
    assert.doesNotMatch(error.message, /synthetic-key|private host detail/);
    return true;
  });
  assert.equal(mock.written.has("target"), false);
  assert.ok(mock.warnings.length > 0);
  assert.doesNotMatch(mock.warnings.join("\n"), /synthetic-key|private host detail/);
});

test("onboarding resolves the thread host server-side and explicitly writes it even outside the host list", async (t) => {
  const mock = serverMock(t, { hosts: ["other"] });
  await assert.rejects(mock.waitForKey({ threadId: "waiting-thread", hostId: "other" }));
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(await mock.waitForKey(), { configured: true });
  assert.deepEqual(mock.lookups, [{ threadId: "waiting-thread" }, { environmentId: "thread-environment" }]);
  assert.deepEqual(mock.calls, [{ hostId: "target", ...initialSettings }]);
  assert.deepEqual(mock.written.get("target"), initialSettings);
});

test("a fulfilled host call with configured:false does not finish onboarding", async (t) => {
  const mock = serverMock(t, { sync: async () => ({ configured: false }) });
  await assert.rejects(mock.waitForKey());
  assert.equal(mock.written.has("target"), false);
});

test("background and onboarding writes serialize per host and finish with the latest key and URL", { timeout: 3000 }, async (t) => {
  const oldStarted = Promise.withResolvers();
  const oldWrite = Promise.withResolvers();
  const latestStarted = Promise.withResolvers();
  const latestWrite = Promise.withResolvers();
  t.after(() => { oldWrite.resolve(); latestWrite.resolve(); });
  let targetWrites = 0;
  const mock = serverMock(t, {
    sync: async ({ hostId }) => {
      if (hostId === "target") {
        targetWrites += 1;
        if (targetWrites === 1) {
          oldStarted.resolve();
          await oldWrite.promise;
        } else if (targetWrites === 2) {
          latestStarted.resolve();
          await latestWrite.promise;
        }
      }
      return { configured: true };
    },
  });
  mock.changeSettings(initialSettings);
  await oldStarted.promise;
  let completed = false;
  const pending = mock.waitForKey().then((result) => { completed = true; return result; });
  await settle();
  mock.changeSettings(nextSettings);
  oldWrite.resolve();
  await latestStarted.promise;
  assert.equal(completed, false);
  assert.equal(mock.maxActive.get("target"), 1);
  latestWrite.resolve();
  assert.deepEqual(await pending, { configured: true });
  await settle();
  assert.equal(mock.maxActive.get("target"), 1);
  assert.deepEqual(mock.written.get("target"), nextSettings);
  const targetCalls = mock.calls.filter(({ hostId }) => hostId === "target");
  assert.ok(targetCalls.length >= 2);
  assert.deepEqual(targetCalls[0], { hostId: "target", ...initialSettings });
  assert.ok(targetCalls.slice(1).every(({ apiKey, baseUrl }) => apiKey === nextSettings.apiKey && baseUrl === nextSettings.baseUrl));
});

test("onboarding rechecks saved settings after acknowledgement even before the change event arrives", { timeout: 3000 }, async (t) => {
  const started = Promise.withResolvers();
  const write = Promise.withResolvers();
  t.after(() => write.resolve());
  let first = true;
  const mock = serverMock(t, {
    sync: async () => {
      if (first) {
        first = false;
        started.resolve();
        await write.promise;
      }
      return { configured: true };
    },
  });
  const pending = mock.waitForKey();
  await started.promise;
  mock.changeSettings(nextSettings, false);
  write.resolve();
  assert.deepEqual(await pending, { configured: true });
  assert.deepEqual(mock.calls, [
    { hostId: "target", ...initialSettings },
    { hostId: "target", ...nextSettings },
  ]);
  assert.deepEqual(mock.written.get("target"), nextSettings);
});

test("removing the key during a target write invalidates its earlier acknowledgement", { timeout: 3000 }, async (t) => {
  const started = Promise.withResolvers();
  const write = Promise.withResolvers();
  t.after(() => write.resolve());
  const mock = serverMock(t, {
    sync: async ({ apiKey }) => {
      if (apiKey) {
        started.resolve();
        await write.promise;
      }
      return { configured: Boolean(apiKey) };
    },
  });
  const pending = assert.rejects(mock.waitForKey());
  await started.promise;
  mock.changeSettings({ ...initialSettings, apiKey: "" }, false);
  write.resolve();
  await pending;
  assert.equal(mock.calls.at(-1).apiKey, "");
  assert.equal(mock.written.has("target"), false);
});

test("a settings change during the final settings read cannot complete onboarding with a stale acknowledgement", { timeout: 3000 }, async (t) => {
  const checking = Promise.withResolvers();
  const staleRead = Promise.withResolvers();
  const latestStarted = Promise.withResolvers();
  const latestWrite = Promise.withResolvers();
  t.after(() => { staleRead.resolve(); latestWrite.resolve(); });
  let reads = 0;
  const mock = serverMock(t, {
    hosts: ["target"],
    readSettings: async (snapshot) => {
      if (++reads === 2) {
        checking.resolve();
        await staleRead.promise;
      }
      return snapshot;
    },
    sync: async ({ apiKey }) => {
      if (apiKey === nextSettings.apiKey) {
        latestStarted.resolve();
        await latestWrite.promise;
      }
      return { configured: true };
    },
  });
  let completed = false;
  const pending = mock.waitForKey().then((result) => { completed = true; return result; });
  await checking.promise;
  mock.changeSettings(nextSettings);
  staleRead.resolve();
  await latestStarted.promise;
  await settle();
  assert.equal(completed, false);
  latestWrite.resolve();
  assert.deepEqual(await pending, { configured: true });
  assert.deepEqual(mock.written.get("target"), nextSettings);
  assert.equal(mock.maxActive.get("target"), 1);
});

test("key validation hides upstream parse errors and uses only loopback model GETs", async (t) => {
  let requests = 0;
  const upstream = createServer((request, response) => {
    requests += 1;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer synthetic-validation-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("synthetic-validation-key private upstream detail");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const mock = serverMock(t);
  mock.changeSettings({ ...initialSettings, baseUrl: `http://127.0.0.1:${upstream.address().port}` }, false);
  await assert.rejects(mock.validateKey("synthetic-validation-key"), (error) => {
    assert.doesNotMatch(error.message, /synthetic|private upstream detail/);
    return true;
  });
  assert.equal(requests, 2);
});
