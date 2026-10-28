import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRpcChild, buildPiChildEnv } from "../dist/tests/pi-child.js";

function spawnOnPlatform(platform, args) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: platform });
    return new PiRpcChild(args);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

for (const platform of ["darwin", "linux", "win32"]) {
  test(`Pi startup preserves RPC and argv with ${platform} process titles`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "vrata-title-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const witness = join(root, "native-title.cjs");
    await writeFile(witness, `
      let title = "native-initial";
      globalThis.nativeTitleWrites = [];
      Object.defineProperty(process, "title", {
        configurable: true, get: () => title,
        set: value => { title = String(value); nativeTitleWrites.push(title); },
      });
    `);
    const child = spawnOnPlatform(platform, {
      launch: { command: process.execPath, args: ["--require", witness, "--eval", `
        process.title = "pi-rpc";
        process.title = "pi-working";
        require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
          const request = JSON.parse(line);
          console.log(JSON.stringify({ id: request.id, type: "response", command: request.type,
            success: true, data: { title: process.title, writes: nativeTitleWrites, argv: process.argv.slice(1) } }));
        });
      `, "--"] },
      cwd: root, env: buildPiChildEnv({}), args: ["--mode", "rpc"],
      onEvent() {}, onChannelMessage() {}, onExit() {}, recordThreadId: null,
    });
    t.after(() => child.closeGracefully());
    assert.deepEqual(await child.requestOk({ type: "get_state" }), {
      title: "pi-working", writes: platform === "darwin" ? [] : ["pi-rpc", "pi-working"],
      argv: ["--mode", "rpc"],
    });
  });
}

test("embedded Pi serves RPC on macOS without calling the native title setter", async (t) => {
  const { preparePiRuntime } = await import("../dist/tests/pi-runtime.js");
  const root = await mkdtemp(join(tmpdir(), "vrata-native-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await preparePiRuntime(root);
  const witness = join(root, "native-title.cjs");
  await writeFile(witness, `
    Object.defineProperty(process, "title", {
      configurable: true, get: () => "native-initial",
      set() { throw new Error("Pi called the native process title setter"); },
    });
  `);
  const child = spawnOnPlatform("darwin", {
    launch: { command: process.execPath, args: ["--require", witness, runtime.rpcEntry] },
    cwd: root, env: buildPiChildEnv({ ...runtime.env, PI_TELEMETRY: "off" }),
    args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", runtime.sessionDir],
    onEvent() {}, onChannelMessage() {}, onExit() {}, recordThreadId: null,
  });
  t.after(() => child.closeGracefully());
  assert.equal((await child.requestOk({ type: "get_state" })).isStreaming, false);
});

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
