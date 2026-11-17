import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

// Exercise current sources without rebuilding dist or changing the installed package.
async function loadSource(entry, packageManifest = manifest) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22",
    loader: { ".br": "binary" },
    banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{ name: "staging-manifest", setup(builder) {
      builder.onLoad({ filter: /package\.json$/ }, ({ path }) => path === manifestPath
        ? { contents: JSON.stringify(packageManifest), loader: "json" } : undefined);
    } }],
  });
  const source = `${result.outputFiles[0].text}\n//# sourceURL=vrata-compatibility-${entry}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("provider icon registers as an agent through the standalone app API", async () => {
  const icons = [];
  const app = await loadPluginApp(async () => {
    const module = await loadSource("app.tsx");
    return { default: { ...module.default, setup(builder) {
      module.default.setup({ ...builder, slots: { ...builder.slots,
        experimental_providerIcon(registration) {
          icons.push(registration);
          builder.slots.experimental_providerIcon(registration);
        },
      } });
    } } };
  });
  assert.equal(app.providerIcons.length, 1);
  assert.equal(icons[0].providerId, "vrata");
  assert.equal(icons[0].providerKind, "agent");
  assert.equal(typeof icons[0].icon, "function");
});

test("bridge handshake explicitly declines command listing without changing Pi capabilities", async (t) => {
  const { experimental_providerBridge: bridge } = await loadSource("bridge.ts");
  const messages = [];
  const write = t.mock.method(process.stdout, "write", (line) => {
    messages.push(JSON.parse(line));
    return true;
  });
  bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "compatibility", method: "initialize",
    params: { protocolVersion: 2, client: { name: "compatibility", version: "1" }, grammarVersions: [3, 3] },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  write.mock.restore();
  assert.equal(bridge.experimental_apiVersion, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result.protocolVersion, 2);
  assert.deepEqual(messages[0].result.capabilities.commands, { list: false });
  assert.deepEqual(messages[0].result.capabilities.skills, { configure: true });
  assert.deepEqual(messages[0].result.capabilities.grammarVersions, [3, 3]);
});

test("model discovery reports the resolved Pi reasoning ladder, including models without reasoning", async () => {
  const { buildPiModels, buildPiAvailableModels } = await loadSource("vrata.ts");
  const catalog = [
    { id: "sparse", protocol: "openai", gateway_metadata: { reasoning_levels: ["low", "high"] } },
    { id: "disabled", protocol: "openai", gateway_metadata: { supports_reasoning: false } },
  ];
  const { models } = buildPiAvailableModels(buildPiModels(catalog, "http://127.0.0.1"));
  assert.deepEqual(models.map(({ id, reasoningDiscovery, supportedReasoningEfforts, defaultReasoningEffort }) => ({
    id, reasoningDiscovery, levels: supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort), defaultReasoningEffort,
  })), [
    { id: "sparse", reasoningDiscovery: "known", levels: ["low", "high"], defaultReasoningEffort: "low" },
    { id: "disabled", reasoningDiscovery: "known", levels: [], defaultReasoningEffort: "none" },
  ]);
});

test("compiled server keeps the staging distribution marker and full runtime version in User-Agent", async (t) => {
  const previous = process.env.BB_APP_VERSION;
  process.env.BB_APP_VERSION = "1.0.0-preview.2+1320c88e8";
  t.after(() => {
    if (previous === undefined) delete process.env.BB_APP_VERSION;
    else process.env.BB_APP_VERSION = previous;
  });
  const { buildUserAgent } = await loadSource("user-agent.ts");
  for (const distribution of ["vrata-bb-plugin", "vrata-bb"]) {
    const staged = distribution === "vrata-bb" ? { ...manifest, vrataDistribution: distribution } : manifest;
    const { default: plugin } = await loadSource("server.ts", staged);
    let declaration;
    const methods = {};
    const calls = [];
    plugin({
      pluginId: "bb-plugin", onDispose() {},
      hosts: { experimental_client: () => ({ call: async (method, input) => {
        calls.push({ method, input });
        return { configured: true, baseUrl: "http://127.0.0.1/v1" };
      } }) },
      rpc: { register: (_contract, handlers) => Object.assign(methods, handlers) },
      providers: { register: (value) => { declaration = value; return { dispose() {} }; } },
      sdk: { subscribe: () => () => {}, hosts: { get: async () => ({ id: "local", name: "Local" }) },
        system: { reloadConfig: async () => {} } },
      http: { route() {} }, events: { on() {} },
    });
    await methods.saveCredentials({ target: { kind: "host", hostId: "local" },
      apiKey: "synthetic-compatibility", baseUrl: "http://127.0.0.1" });
    await methods.balance({ hostId: "local" });
    const client = { distribution, bbVersion: process.env.BB_APP_VERSION };
    assert.deepEqual(declaration.experimental_bridgeOptions, { vrataClient: client });
    assert.deepEqual(calls.map(({ input }) => input.client), [client, client]);
    const product = distribution === "vrata-bb"
      ? `vrata-bb/${client.bbVersion} vrata-bb-plugin/${manifest.version}`
      : `vrata-bb-plugin/${manifest.version} bb/${client.bbVersion}`;
    assert.equal(buildUserAgent(client), `${product} (${platform()} ${release()}; ${arch()})`);
  }
});
