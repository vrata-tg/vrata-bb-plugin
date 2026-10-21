import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = new URL("../dist/tests/", import.meta.url);
await build({
  entryPoints: [fileURLToPath(new URL("../packaging/pi/runtime.js", import.meta.url))],
  outfile: fileURLToPath(new URL("pi-runtime-asset.js", output)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
// SDK 0.4.34 includes CJS requires; use the same Node bundling boundary as BB.
await build({
  entryPoints: [fileURLToPath(new URL("../pi/events.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("pi-events.js", output)),
  bundle: true, platform: "node", format: "esm", target: "node22",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await writeFile(new URL("package.json", output), JSON.stringify({
  type: "module",
  imports: { "#vrata-pi-runtime": "./pi-runtime-asset.js" },
}, null, 2) + "\n");
