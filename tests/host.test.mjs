import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "../dist/host.js";

const models = { data: [{ id: "gemini-3.8-flash" }] };
const account = {
  checked_at: "2026-10-21T00:00:00Z",
  balance: { currency: "RUB", unit: "coin_atoms", paid_available: "20", promo_available: "3", reserved: "1", spendable: "22" },
};
const json = (response, body) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
const safeError = (error) => {
  assert.doesNotMatch(error.message, /synthetic-|private upstream|Authorization|credentials\.json/);
  return true;
};

async function upstream(t, handler = (_request, response) => json(response, models)) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

async function fixture(t, original) {
  const root = await mkdtemp(join(tmpdir(), "vrata-host-local-"));
  const bridgeDir = join(root, "bridge-data");
  const credentialsPath = join(bridgeDir, "credentials.json");
  await mkdir(bridgeDir);
  if (original) await writeFile(credentialsPath, JSON.stringify(original), { mode: 0o600 });
  const harness = experimental_createHostEntryHarness(host, {
    experimental_paths: { dataDir: join(root, "host-data"), tempDir: join(root, "temp") },
  });
  t.after(async () => { await harness.experimental_dispose(); await rm(root, { recursive: true, force: true }); });
  return { harness, bridgeDir, credentialsPath, read: async () => JSON.parse(await readFile(credentialsPath, "utf8")) };
}

async function heldValidation(t) {
  const started = Promise.withResolvers();
  const pending = [];
  const api = await upstream(t, (request, response) => {
    if (request.headers.authorization === "Bearer synthetic-held") {
      pending.push(response);
      if (pending.length === 2) started.resolve();
    } else json(response, models);
  });
  const release = () => { for (const response of pending.splice(0)) json(response, models); };
  t.after(release);
  return { ...api, started: started.promise, release };
}

test("existing host-local credentials and native roots work without migration or key readback", async (t) => {
  const api = await upstream(t, (_request, response) => json(response, account));
  const original = { apiKey: "synthetic-provisioned", baseUrl: api.baseUrl };
  const f = await fixture(t, original);
  assert.deepEqual(await f.harness.experimental_call("getConfiguration", null), { configured: true, baseUrl: `${api.baseUrl}/v1` });
  assert.equal(api.requests.length, 0);
  const balance = await f.harness.experimental_call("balance", null);
  assert.deepEqual(balance, { status: "ok", checkedAt: account.checked_at, spendable: "22", paid: "20", promo: "3", reserved: "1" });
  assert.deepEqual(api.requests, [{ method: "GET", path: "/v1/account", authorization: "Bearer synthetic-provisioned" }]);
  assert.deepEqual(await f.read(), original);
  const agentDir = join(f.bridgeDir, "pi-agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ skills: ["./custom-skills", "./custom-skills", "!disabled", "npm:external", "./single/SKILL.md"] }));
  const roots = await f.harness.experimental_call("resolveNativeRoots", { providerId: "vrata", cwd: null });
  assert.deepEqual(roots.skills.map(({ path }) => path).sort(), [join(agentDir, "custom-skills"), join(agentDir, "skills")].sort());
});

test("save validates only model GETs, preserves an opaque key and atomically rotates a private file", async (t) => {
  const api = await upstream(t);
  const second = await upstream(t);
  const f = await fixture(t);
  const untouched = await fixture(t, { apiKey: "synthetic-other-machine", baseUrl: second.baseUrl });
  const key = '{"synthetic":"opaque","env":"NOT_AN_ENV_LOOKUP"}';
  for (const [endpoint, apiKey] of [[api, key], [second, "synthetic-rotated"]]) {
    const result = await f.harness.experimental_call("saveCredentials", { apiKey, baseUrl: endpoint.baseUrl });
    assert.deepEqual(result, { configured: true, baseUrl: `${endpoint.baseUrl}/v1` });
    assert.deepEqual(await f.read(), { apiKey, baseUrl: `${endpoint.baseUrl}/v1` });
    if (process.platform !== "win32") assert.equal((await stat(f.credentialsPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(f.bridgeDir), ["credentials.json"]);
    assert.equal(endpoint.requests.length, 2);
    assert.ok(endpoint.requests.every(({ method, path, authorization }) => method === "GET" && path === "/v1/models" && authorization === `Bearer ${apiKey}`));
  }
  assert.deepEqual(await untouched.read(), { apiKey: "synthetic-other-machine", baseUrl: second.baseUrl });
  assert.deepEqual(await f.harness.experimental_call("deleteCredentials", null), { configured: false, baseUrl: "https://api.vrata.tg" });
  await assert.rejects(readFile(f.credentialsPath), { code: "ENOENT" });
  assert.deepEqual(await f.harness.experimental_call("balance", null), { status: "unconfigured" });
  assert.equal(second.requests.length, 2);
});

test("invalid key, malformed catalog, empty catalog and invalid URL preserve the previous file with safe errors", async (t) => {
  const original = { apiKey: "synthetic-previous", baseUrl: "https://api.vrata.tg" };
  const f = await fixture(t, original);
  const oldBytes = await readFile(f.credentialsPath, "utf8");
  const api = await upstream(t, (request, response) => {
    if (request.headers.authorization === "Bearer synthetic-denied") {
      response.writeHead(401);
      response.end("synthetic-denied private upstream detail");
    } else if (request.headers.authorization === "Bearer synthetic-malformed") {
      response.end("synthetic-malformed private upstream detail");
    } else json(response, { data: [] });
  });
  for (const apiKey of ["synthetic-denied", "synthetic-malformed", "synthetic-empty"]) {
    await assert.rejects(f.harness.experimental_call("saveCredentials", { apiKey, baseUrl: api.baseUrl }), safeError);
    assert.equal(await readFile(f.credentialsPath, "utf8"), oldBytes);
  }
  await assert.rejects(f.harness.experimental_call("saveCredentials", { apiKey: "synthetic-url", baseUrl: `${api.baseUrl}/private` }), safeError);
  assert.equal(api.requests.length, 6);
  assert.equal(await readFile(f.credentialsPath, "utf8"), oldBytes);
  assert.deepEqual(await readdir(f.bridgeDir), ["credentials.json"]);
});

test("request cancellation and worker disposal reject held validation before any write", { timeout: 5000 }, async (t) => {
  for (const cancel of ["request", "worker"]) {
    const api = await heldValidation(t);
    const original = { apiKey: "synthetic-existing", baseUrl: api.baseUrl };
    const f = await fixture(t, original);
    const controller = new AbortController();
    const pending = assert.rejects(f.harness.experimental_call("saveCredentials", {
      apiKey: "synthetic-held", baseUrl: api.baseUrl,
    }, { signal: controller.signal }), safeError);
    await api.started;
    if (cancel === "request") controller.abort();
    else await f.harness.experimental_dispose();
    await pending;
    api.release();
    assert.deepEqual(await f.read(), original);
    assert.deepEqual(await readdir(f.bridgeDir), ["credentials.json"]);
  }
});

test("delete wins over an older held validation and the late save cannot recreate credentials", { timeout: 5000 }, async (t) => {
  const api = await heldValidation(t);
  const f = await fixture(t, { apiKey: "synthetic-existing", baseUrl: api.baseUrl });
  const pending = assert.rejects(f.harness.experimental_call("saveCredentials", { apiKey: "synthetic-held", baseUrl: api.baseUrl }), safeError);
  await api.started;
  await f.harness.experimental_call("deleteCredentials", null);
  api.release();
  await pending;
  await assert.rejects(readFile(f.credentialsPath), { code: "ENOENT" });
  assert.deepEqual(await f.harness.experimental_call("getConfiguration", null), { configured: false, baseUrl: "https://api.vrata.tg" });
  assert.deepEqual(await readdir(f.bridgeDir), []);
});

test("newer save wins over an older held validation including key and URL", { timeout: 5000 }, async (t) => {
  const api = await heldValidation(t);
  const latest = await upstream(t);
  const f = await fixture(t);
  const pending = assert.rejects(f.harness.experimental_call("saveCredentials", { apiKey: "synthetic-held", baseUrl: api.baseUrl }), safeError);
  await api.started;
  const replacement = { apiKey: "synthetic-newest", baseUrl: latest.baseUrl };
  await f.harness.experimental_call("saveCredentials", replacement);
  api.release();
  await pending;
  assert.deepEqual(await f.read(), { ...replacement, baseUrl: `${latest.baseUrl}/v1` });
  if (process.platform !== "win32") assert.equal((await stat(f.credentialsPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.bridgeDir), ["credentials.json"]);
});

test("an in-flight balance keeps its local credential snapshot after deletion", { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers();
  let response;
  const api = await upstream(t, (_request, res) => { response = res; started.resolve(); });
  const f = await fixture(t, { apiKey: "synthetic-balance-snapshot", baseUrl: api.baseUrl });
  const pending = f.harness.experimental_call("balance", null);
  await started.promise;
  await f.harness.experimental_call("deleteCredentials", null);
  json(response, account);
  assert.equal((await pending).status, "ok");
  assert.equal(api.requests[0].authorization, "Bearer synthetic-balance-snapshot");
  assert.deepEqual(await f.harness.experimental_call("balance", null), { status: "unconfigured" });
  assert.equal(api.requests.length, 1);
});
