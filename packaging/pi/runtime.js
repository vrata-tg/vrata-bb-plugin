import { brotliDecompressSync } from "node:zlib";
import archive from "./runtime.json.br" with { type: "bytes" };
import metadata from "./runtime-meta.json" with { type: "json" };

let files;
export default {
  ...metadata,
  get files() {
    return files ??= Object.fromEntries(
      Object.entries(JSON.parse(brotliDecompressSync(archive).toString("utf8")))
        .map(([path, [encoding, content]]) => [path, Buffer.from(content, encoding)]),
    );
  },
};
