import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { credentialsContract } from "./contract.js";

export { experimental_providerBridge } from "./bridge.js";

export default experimental_defineHostEntry({
  contract: credentialsContract,
  handlers: {
    sync: ({ apiKey, baseUrl }, context) => {
      // bb gives the host worker and the bridge separate directories under
      // the same plugin root. The bridge reads only its own bridge-data.
      const root = join(dirname(context.experimental_paths.dataDir), "bridge-data");
      const path = join(root, "credentials.json");
      if (!apiKey) {
        rmSync(path, { force: true });
        return { configured: false };
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temp = join(root, `credentials.${process.pid}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify({ apiKey, baseUrl }), { mode: 0o600 });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
      return { configured: true };
    },
  },
});
