import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import test from "node:test";
import { fixture, models } from "./bridge-fixture.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

for (const distribution of ["vrata-bb", "vrata-bb-plugin"]) {
  test(`${distribution} identifies catalog and native Pi requests on the execution host`, { timeout: 60000 }, async (t) => {
    const client = { distribution, bbVersion: "0.46.1" };
    const product = distribution === "vrata-bb"
      ? `vrata-bb/0.46.1 vrata-bb-plugin/${version}` : `vrata-bb-plugin/${version} bb/0.46.1`;
    const expected = `${product} (${platform()} ${release()}; ${arch()})`;
    const f = await fixture(t, {}, { pluginId: "bb-plugin", vrataClient: client });
    await f.rpc("model/list", {});
    assert.ok(f.gateway.catalogRequests.length >= 2);
    assert.ok(f.gateway.catalogRequests.every((request) => request.headers["user-agent"] === expected));
    for (const model of Object.values(models)) {
      await f.start({ options: { model, reasoningLevel: "high" } });
      await f.turn("Loopback User-Agent verification", { model, reasoningLevel: "high" });
      assert.equal((await f.boundary()).status, "completed");
      assert.equal(f.gateway.requests.at(-1).userAgent, expected);
    }
  });
}
