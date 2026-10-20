import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { buildUserMessage, InputError } from "../dist/tests/bridge-input.js";
import photon from "../packaging/photon.cjs";

const temporary = await mkdtemp(join(tmpdir(), "vrata-input-"));
after(() => rm(temporary, { recursive: true, force: true }));

// Produce real PNG bytes so the resize check does not depend on Pi to create its input.
function png(width = 1, height = 1) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    result.writeUInt32BE(crc32(body), result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4), 0xff);
  for (let row = 0; row < height; row++) rows[row * (1 + width * 4)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const smallPng = png();
const imageUrl = `data:image/png;base64,${smallPng.toString("base64")}`;
const build = (input, modelImages = true, signal = new AbortController().signal) =>
  buildUserMessage(input, temporary, modelImages, signal);

// Failed assertions must not print the prompt, attachment bytes, URL or response.
function same(actual, expected, message) {
  assert.ok(isDeepStrictEqual(actual, expected), message);
}
async function failure(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("Input should have been rejected");
}
async function inputFailure(operation) {
  const error = await failure(operation);
  assert.ok(error instanceof InputError, "Expected a safe adapter error");
  assert.ok(!/private|secret|http:|https:|data:|ENOENT/.test(error.message), "Error must not disclose input or upstream details");
  assert.ok(error.cause === undefined, "Error must not retain an upstream cause");
  return error;
}
async function loopback(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("text blocks preserve order, whitespace and agent-only content", async () => {
  const input = [
    { type: "text", text: "  first\n" },
    { type: "text", text: "" },
    { type: "text", text: "второй 🐈", visibility: "agent-only" },
  ];
  const started = Date.now();
  const message = await build(input, false);
  same(message.content, input.map(({ text }) => ({ type: "text", text })), "All text blocks should be preserved");
  assert.ok(message.role === "user" && message.timestamp >= started && message.timestamp <= Date.now());
});

test("local files resolve against cwd and preserve complete UTF-8 and empty attachments", async () => {
  const text = "\ufeffПривет 🐈\n\tconst x = 1;\r\n";
  await writeFile(join(temporary, "source.txt"), text);
  await writeFile(join(temporary, "empty.txt"), "");
  const message = await build([
    { type: "localFile", path: "source.txt", name: "example.txt", mimeType: "text/plain; charset=utf-8" },
    { type: "localFile", path: join(temporary, "empty.txt"), name: "empty.txt" },
  ], false);
  same(message.content, [
    { type: "text", text: '[File: "example.txt"]\n' + text },
    { type: "text", text: '[File: "empty.txt"]\n' },
  ], "File labels and full UTF-8 contents should be retained");
});

test("image-only, percent-encoded data URL, localImage and localFile reach Pi as image bytes", async () => {
  await writeFile(join(temporary, "picture-without-extension"), smallPng);
  const image = { type: "image", data: smallPng.toString("base64"), mimeType: "image/png" };
  same((await build([{ type: "image", url: imageUrl }])).content, [image], "Image-only input should be accepted");
  const percentUrl = "data:image/png," + [...smallPng].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const message = await build([
    { type: "text", text: "before" },
    { type: "image", url: percentUrl },
    { type: "localImage", path: "picture-without-extension" },
    { type: "localFile", path: "picture-without-extension", name: "picture", mimeType: "application/octet-stream" },
    { type: "text", text: "after" },
  ]);
  same(message.content, [
    { type: "text", text: "before" }, image, image,
    { type: "text", text: '[File: "picture"]\n' }, image,
    { type: "text", text: "after" },
  ], "Mixed attachment order and decoded bytes should be preserved");
});

test("large images pass through the actual Pi resize pipeline with coordinate metadata", async () => {
  const bytes = png(2400, 12);
  await writeFile(join(temporary, "wide.png"), bytes);
  const message = await build([{ type: "localImage", path: "wide.png" }]);
  const image = message.content[0];
  assert.ok(image.type === "image" && image.mimeType === "image/png", "Resized image should be inline PNG");
  const resized = Buffer.from(image.data, "base64");
  assert.ok(resized.readUInt32BE(16) === 2000 && resized.readUInt32BE(20) === 10, "Pi should reduce image dimensions");
  assert.ok(message.content[1].type === "text" && /2400x12.*2000x10/.test(message.content[1].text), "Coordinates should describe original and resized dimensions");
});

test("JPEG, GIF and WebP are detected from bytes rather than extension or supplied MIME", async () => {
  const source = photon.PhotonImage.new_from_byteslice(smallPng);
  let formats;
  try {
    formats = [
      ["image/jpeg", Buffer.from(source.get_bytes_jpeg(80))],
      ["image/webp", Buffer.from(source.get_bytes_webp())],
      ["image/gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
    ];
  } finally {
    source.free();
  }
  for (const [mimeType, bytes] of formats) {
    await writeFile(join(temporary, "unknown-image"), bytes);
    const message = await build([{ type: "localFile", path: "unknown-image", mimeType: "image/png" }]);
    same(message.content[1], { type: "image", mimeType, data: bytes.toString("base64") }, "Actual image format and bytes should reach Pi");
  }
});

test("remote images and redirects load without authorization, cookies or referrer", async (t) => {
  const requests = [];
  const base = await loopback(t, (request, response) => {
    requests.push({
      path: request.url, method: request.method,
      authorization: request.headers.authorization, cookie: request.headers.cookie, referer: request.headers.referer,
    });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/image", "set-cookie": "session=secret-test-cookie" }).end();
    } else {
      response.writeHead(200, { "content-type": "image/png" }).end(smallPng);
    }
  });
  const message = await build([{ type: "image", url: `${base}/redirect` }]);
  same(message.content, [{ type: "image", data: smallPng.toString("base64"), mimeType: "image/png" }], "Remote bytes should become image content");
  same(requests.map(({ path }) => path), ["/redirect", "/image"], "Image redirect should be followed");
  assert.ok(requests.every(({ method, authorization, cookie, referer }) =>
    method === "GET" && authorization === undefined && cookie === undefined && referer === undefined),
  "Attachment downloads must not authenticate or send a referrer");
});

test("remote errors, invalid URLs and corrupt images return safe InputError messages", async (t) => {
  const base = await loopback(t, (request, response) => {
    if (request.url === "/broken") {
      response.writeHead(200, { "content-type": "image/png", "content-length": smallPng.length + 10 });
      response.write(smallPng.subarray(0, 8));
      response.destroy();
    } else {
      response.writeHead(403).end("private upstream response secret-test-key");
    }
  });
  for (const url of [
    `${base}/private?key=secret-test-key`, `${base}/broken`,
    "not-a-url-private", "file:///private", "http://private:secret@127.0.0.1/",
    "data:image/png;base64,not-valid-private", "data:image/png,private",
    `data:image/png;base64,${smallPng.subarray(0, 8).toString("base64")}`,
  ]) {
    await inputFailure(() => build([{ type: "image", url }]));
  }
});

test("binary files, invalid UTF-8, missing paths and unsupported input reject the whole message", async () => {
  const cases = [
    { name: "bad-utf8", bytes: Buffer.from([0xc3, 0x28]) },
    { name: "control", bytes: Buffer.from("before\0after") },
    { name: "pdf", bytes: Buffer.from("%PDF-1.7\nASCII contents\n%%EOF") },
    { name: "binary-mime", bytes: Buffer.from("ASCII"), mimeType: "application/pdf" },
    { name: "broken-image", bytes: smallPng.subarray(0, 8) },
  ];
  for (const item of cases) {
    await writeFile(join(temporary, item.name), item.bytes);
    await inputFailure(() => build([
      { type: "text", text: "keep all attachments" },
      { type: "localFile", path: item.name, mimeType: item.mimeType },
    ]));
  }
  await inputFailure(() => build([{ type: "localImage", path: "private-missing-file" }]));
  await inputFailure(() => build([{ type: "localFile", path: "private-missing-file" }]));
  await inputFailure(() => build([{ type: "unknown", value: "private" }]));
  await inputFailure(() => build([]));
  await inputFailure(() => build([{ type: "text", text: " \n\t" }]));
});

test("an unsupported model rejects images instead of silently dropping them", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(smallPng); });
  await inputFailure(() => build([{ type: "image", url: "https://private.test/image" }], false));
  await inputFailure(() => build([{ type: "localImage", path: "private-missing-file" }], false));
  await writeFile(join(temporary, "text-model-image"), smallPng);
  await inputFailure(() => build([{ type: "localFile", path: "text-model-image" }], false));
  assert.ok(requests === 0, "Known image input should be rejected before downloading");
});

test("a failing later attachment never returns a partial message", async () => {
  await inputFailure(() => build([
    { type: "text", text: "first" },
    { type: "image", url: imageUrl },
    { type: "localFile", path: "private-missing-last" },
  ]));
});

test("pre-aborted preparation does not perform I/O or wrap the cancellation reason", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(smallPng); });
  const controller = new AbortController();
  controller.abort();
  for (const input of [[{ type: "text", text: "hello" }], [{ type: "image", url: imageUrl }]]) {
    const error = await failure(() => build(input, true, controller.signal));
    assert.ok(error === controller.signal.reason, "Original cancellation should propagate");
  }
  assert.ok(requests === 0, "Aborted preparation must not download");
});

test("a local file read that completes after cancellation cannot return a message", async (t) => {
  const controller = new AbortController();
  await writeFile(join(temporary, "late-read.txt"), "complete text");
  const readFile = fs.readFile;
  const readMock = t.mock.method(fs, "readFile", async (...args) => {
    assert.ok(args[1].signal === controller.signal, "Local reads should receive the turn signal");
    const bytes = await readFile(...args);
    controller.abort();
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
  const error = await failure(() => build([{ type: "localFile", path: "late-read.txt" }], true, controller.signal));
  assert.ok(error === controller.signal.reason, "Late local I/O must remain cancelled");
});

test("cancellation aborts both pending HTTP headers and a pending HTTP body", async (t) => {
  for (const sendHeaders of [false, true]) {
    const controller = new AbortController();
    const base = await loopback(t, (_request, response) => {
      if (sendHeaders) {
        response.writeHead(200, { "content-type": "image/png" });
        response.write(smallPng.subarray(0, 8));
      }
      setImmediate(() => controller.abort());
    });
    const error = await failure(() => build([{ type: "image", url: `${base}/pending` }], true, controller.signal));
    assert.ok(error === controller.signal.reason, "HTTP cancellation should remain cancellation");
  }
});

test("late fetch and body completion after cancellation cannot return a message", async (t) => {
  for (const stage of ["fetch", "body"]) {
    const controller = new AbortController();
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    let reads = 0;
    const response = {
      ok: true,
      async arrayBuffer() {
        reads++;
        if (stage === "body") {
          entered();
          await pending;
        }
        return smallPng;
      },
    };
    const fetchMock = t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.ok(options.credentials === "omit" && options.signal === controller.signal, "Fetch must receive cancellation and omit credentials");
      if (stage === "fetch") {
        entered();
        await pending;
      }
      return response;
    });
    const result = failure(() => build([{ type: "image", url: "https://private.test/image" }], true, controller.signal));
    await reached;
    controller.abort();
    finish();
    assert.ok(await result === controller.signal.reason, "Late I/O must not resume preparation");
    assert.ok(reads === (stage === "fetch" ? 0 : 1), "A late fetch must not start reading its body");
    fetchMock.mock.restore();
  }
});

test("cancellation during embedded Pi resizing rejects its late result and skips later attachments", async (t) => {
  const controller = new AbortController();
  const decode = photon.PhotonImage.new_from_byteslice;
  let decoded = false;
  let downloads = 0;
  t.mock.method(photon.PhotonImage, "new_from_byteslice", function (...args) {
    const result = decode.apply(this, args);
    decoded = true;
    controller.abort();
    return result;
  });
  t.mock.method(globalThis, "fetch", async () => { downloads++; return new Response(smallPng); });
  await writeFile(join(temporary, "cancel-resize.png"), smallPng);
  const error = await failure(() => build([
    { type: "localImage", path: "cancel-resize.png" },
    { type: "image", url: "https://private.test/later" },
  ], true, controller.signal));
  assert.ok(decoded, "The embedded resize runtime should have decoded the actual image");
  assert.ok(error === controller.signal.reason, "Resize completion after cancellation must be rejected");
  assert.ok(downloads === 0, "Cancellation must skip later attachments");
});
