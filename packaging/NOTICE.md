# Embedded image runtime

Photon bindings and WASM: @silvia-odwyer/photon-node 0.3.4, pinned by
@earendil-works/pi-coding-agent 0.84.0 in package-lock.json.
Upstream: https://github.com/silvia-odwyer/photon
Author: Silvia O'Dwyer. License: Apache-2.0 (PHOTON-LICENSE.txt).

Resize and EXIF algorithm: @earendil-works/pi-coding-agent 0.84.0.
Upstream: https://github.com/earendil-works/pi/tree/v0.84.0
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
- photon_rs.js: d60656705f0d59baa79e36b0381eb023f1864eeb57e92956cf21dcd9fb8f879f
- photon_rs_bg.wasm: 10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c
- image-resize-core.js: 5f6f1464c21e196a5742b943a403aa843fb319c9d2ff024ca04bb809a18de261
- exif-orientation.js: 5e7a34be16830e728bb6194950a53109d1e4f6df54864a9650063892fab78f19
