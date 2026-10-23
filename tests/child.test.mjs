import assert from "node:assert/strict";
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
