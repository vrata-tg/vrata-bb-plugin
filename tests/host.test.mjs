import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "../dist/host.js";

test("host settings and native roots use the bridge private directory through the SDK contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vrata-host-contract-"));
  const harness = experimental_createHostEntryHarness(host, {
    experimental_paths: { dataDir: join(root, "host-data"), tempDir: join(root, "temp") },
  });
  t.after(async () => { await harness.experimental_dispose(); await rm(root, { recursive: true, force: true }); });
  const bridgeDir = join(root, "bridge-data");
  const credentialsPath = join(bridgeDir, "credentials.json");
  const original = { apiKey: "synthetic-host-key-a", baseUrl: "http://127.0.0.1:19001" };
  const rotated = { apiKey: "synthetic-host-key-b", baseUrl: "http://127.0.0.1:19002" };
  for (const config of [original, rotated]) {
    assert.deepEqual(await harness.experimental_call("sync", config), { configured: true });
    assert.deepEqual(JSON.parse(await readFile(credentialsPath, "utf8")), config);
    assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(bridgeDir), ["credentials.json"]);
  }
  const agentDir = join(bridgeDir, "pi-agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ skills: ["./custom-skills", "./custom-skills", "!disabled", "npm:external", "./single/SKILL.md"] }));
  const resolved = await harness.experimental_call("resolveNativeRoots", { providerId: "vrata", cwd: null });
  assert.deepEqual(resolved.skills.map(({ path }) => path).sort(), [join(agentDir, "custom-skills"), join(agentDir, "skills")].sort());
  assert.deepEqual(await harness.experimental_call("sync", { ...rotated, apiKey: "" }), { configured: false });
  await assert.rejects(readFile(credentialsPath), { code: "ENOENT" });
});
