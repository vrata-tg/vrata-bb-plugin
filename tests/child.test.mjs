import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import test from "node:test";
import { PiRpcChild, buildPiChildEnv } from "../dist/tests/pi-child.js";

test("Pi RPC runs in Node mode when launched with the BB executable", async (t) => {
  // Electron exits without serving RPC when its Node-mode flag is missing.
  const child = new PiRpcChild({
    launch: { command: process.execPath, args: ["--eval", `
      if (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(0);
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        console.log(JSON.stringify({ id: request.id, type: "response", command: request.type,
          success: true, data: { isStreaming: false } }));
      });
    `] },
    cwd: process.cwd(), env: buildPiChildEnv({}), args: [],
    onEvent() {}, onChannelMessage() {}, onExit() {}, recordThreadId: null,
  });
  t.after(() => child.closeGracefully());
  assert.deepEqual(await child.requestOk({ type: "get_state" }), { isStreaming: false });
});

test("Pi RPC starts hidden without inheriting the desktop app identity", async (t) => {
  const spawnMock = t.mock.method(ChildProcess.prototype, "spawn");
  const env = { ...buildPiChildEnv({}), __CFBundleIdentifier: "tg.vrata.bb", PI_STARTUP_FIXTURE: "preserved" };
  const child = new PiRpcChild({
    launch: { command: process.execPath, args: ["--eval", `
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        console.log(JSON.stringify({ id: request.id, type: "response", command: request.type,
          success: true, data: {
            bundleId: process.env.__CFBundleIdentifier ?? null,
            nodeMode: process.env.ELECTRON_RUN_AS_NODE,
            fixture: process.env.PI_STARTUP_FIXTURE,
          } }));
      });
    `] },
    cwd: process.cwd(), env, args: [],
    onEvent() {}, onChannelMessage() {}, onExit() {}, recordThreadId: null,
  });
  t.after(() => child.closeGracefully());
  assert.equal(spawnMock.mock.calls.at(-1).arguments[0].windowsHide, true);
  assert.deepEqual(await child.requestOk({ type: "get_state" }), {
    bundleId: null, nodeMode: "1", fixture: "preserved",
  });
  assert.equal(env.__CFBundleIdentifier, "tg.vrata.bb", "Launching Pi must not mutate its caller's environment");
});
