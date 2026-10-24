import manifest from "../package.json" with { type: "json" };
import type { VrataClient } from "./contract.js";

export function buildUserAgent(client?: VrataClient): string {
  // Balance schemas also reach the browser; load OS APIs only on the host.
  const { arch, platform, release } = process.getBuiltinModule("node:os");
  const bbVersion = client?.bbVersion ?? "unknown";
  const plugin = `vrata-bb-plugin/${manifest.version}`;
  const product = client?.distribution === "vrata-bb"
    ? `vrata-bb/${bbVersion} ${plugin}` : `${plugin} bb/${bbVersion}`;
  return `${product} (${platform()} ${release()}; ${arch()})`;
}
