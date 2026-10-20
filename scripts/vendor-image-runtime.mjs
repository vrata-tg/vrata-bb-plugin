import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// BB transfers one host.js, without worker or WASM sidecars. Preserve the pinned
// Pi resize algorithm and Photon bindings; change only how Photon is loaded.
const piDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const photonDir = dirname(createRequire(join(piDir, "package.json")).resolve("@silvia-odwyer/photon-node"));
const outputDir = fileURLToPath(new URL("../packaging/", import.meta.url));
const piVersion = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version;
const photonVersion = JSON.parse(readFileSync(join(photonDir, "package.json"), "utf8")).version;
if (piVersion !== "0.84.0" || photonVersion !== "0.3.4") throw new Error("Review the new Pi/Photon versions before regenerating");
const source = readFileSync(join(photonDir, "photon_rs.js"), "utf8");
const wasm = readFileSync(join(photonDir, "photon_rs_bg.wasm"));
const loader = "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');\nconst bytes = require('fs').readFileSync(path);";
if (!source.includes(loader)) throw new Error("Photon WASM loader changed");
const embeddedLoader = 'const bytes = require("node:zlib").gunzipSync(Buffer.from(require("./photon-wasm.json"), "base64"));';
const core = readFileSync(join(piDir, "dist/utils/image-resize-core.js"), "utf8");
const photonImport = 'import { loadPhoton } from "./photon.js";';
if (!core.includes(photonImport)) throw new Error("Pi Photon import changed");
const exif = readFileSync(join(piDir, "dist/utils/exif-orientation.js"), "utf8");
const declarations = readFileSync(join(piDir, "dist/utils/image-resize-core.d.ts"), "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const withoutSourceMap = (text) => `${text.replace(/^\/\/# sourceMappingURL=.*$/m, "").trimEnd()}\n`;
const piLicense = await fetch(`https://raw.githubusercontent.com/earendil-works/pi/v${piVersion}/LICENSE`, { redirect: "error" });
if (!piLicense.ok) throw new Error(`Pi license: HTTP ${piLicense.status}`);
const licenseText = await piLicense.text();

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "photon.cjs"), `// Photon ${photonVersion}, Apache-2.0. See NOTICE.md and PHOTON-LICENSE.txt.\n// Regenerate with node scripts/vendor-image-runtime.mjs.\n${source.replace(loader, embeddedLoader).trimEnd()}\n`);
writeFileSync(join(outputDir, "photon-wasm.json"), `${JSON.stringify(gzipSync(wasm, { level: 9 }).toString("base64"))}\n`);
writeFileSync(join(outputDir, "PHOTON-LICENSE.txt"), readFileSync(join(photonDir, "LICENSE.md"), "utf8").replace(/\r\n/g, "\n"));
const piHeader = `// Pi ${piVersion}, MIT. See NOTICE.md and PI-LICENSE.txt.\n// Regenerate with node scripts/vendor-image-runtime.mjs.\n`;
writeFileSync(join(outputDir, "image-resize-core.js"), piHeader + withoutSourceMap(core.replace(photonImport,
  'async function loadPhoton() { return (await import("./photon.cjs")).default; }')));
writeFileSync(join(outputDir, "image-resize-core.d.ts"), piHeader + withoutSourceMap(declarations));
writeFileSync(join(outputDir, "exif-orientation.js"), piHeader + withoutSourceMap(exif));
writeFileSync(join(outputDir, "PI-LICENSE.txt"), licenseText);
writeFileSync(join(outputDir, "NOTICE.md"), `# Embedded image runtime

Photon bindings and WASM: @silvia-odwyer/photon-node ${photonVersion}, pinned by
@earendil-works/pi-coding-agent ${piVersion} in package-lock.json.
Upstream: https://github.com/silvia-odwyer/photon
Author: Silvia O'Dwyer. License: Apache-2.0 (PHOTON-LICENSE.txt).

Resize and EXIF algorithm: @earendil-works/pi-coding-agent ${piVersion}.
Upstream: https://github.com/earendil-works/pi/tree/v${piVersion}
Author: Mario Zechner. License: MIT (PI-LICENSE.txt).

photon.cjs preserves the upstream bindings and replaces the two filesystem
WASM-loader lines with decompression of photon-wasm.json. The JSON contains
gzip/base64 of the original WASM, with no changes to its bytes.
image-resize-core.js preserves Pi's algorithm and imports the embedded Photon
module directly. exif-orientation.js and the resize declarations are unchanged,
apart from provenance comments and removal of source-map links.

image-runtime.ts uses these files for attachments and wraps Pi's stock read tool.
The package imports map allows ordinary Node and raw BB builds to resolve the
same source. No postbuild step, sidecar asset, node_modules, runtime download,
or global fs/fetch patch is needed on the deployed host for these image paths.

Regenerate after npm ci with: node scripts/vendor-image-runtime.mjs
The script reads installed pinned packages and downloads their upstream Pi license.
Review an upstream version change before updating the script's version check.

Original SHA-256:
- photon_rs.js: ${sha256(source)}
- photon_rs_bg.wasm: ${sha256(wasm)}
- image-resize-core.js: ${sha256(core)}
- exif-orientation.js: ${sha256(exif)}
`);
