import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { experimental_defineHostEntry, experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { credentialsContract, DEFAULT_BASE_URL } from "./contract.js";
import { fetchBalance } from "./balance.js";
import { apiBaseUrl, fetchModels, readConfig } from "./vrata.js";
import { resolvePiNativeRoots } from "./native-roots.js";
import { buildUserAgent } from "./user-agent.js";

export { experimental_providerBridge } from "./bridge.js";

// Host worker and bridge directories are siblings under the same plugin root.
const bridgeDataDir = (hostDataDir: string): string => join(dirname(hostDataDir), "bridge-data");
// A newer explicit mutation invalidates a still-validating save in this worker.
let credentialMutation = 0;

export default experimental_defineHostEntry({
  contract: { ...credentialsContract, ...experimental_nativeRootsHostContract },
  handlers: {
    resolveNativeRoots: (_input, context) => resolvePiNativeRoots({
      homeDir: homedir(),
      agentDir: join(bridgeDataDir(context.experimental_paths.dataDir), "pi-agent"),
    }),
    getConfiguration: (_input, context) => {
      const config = readConfig(bridgeDataDir(context.experimental_paths.dataDir));
      return { configured: !!config, baseUrl: config?.baseUrl ?? DEFAULT_BASE_URL };
    },
    saveCredentials: async ({ apiKey, baseUrl, client }, context) => {
      try {
        context.signal.throwIfAborted();
        const config = { apiKey, baseUrl: apiBaseUrl(baseUrl) };
        const mutation = ++credentialMutation;
        const models = await fetchModels(config, context.signal, buildUserAgent(client));
        context.signal.throwIfAborted();
        if (!models.length || mutation !== credentialMutation) throw new Error("Save was not accepted");

        const root = bridgeDataDir(context.experimental_paths.dataDir);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const temp = join(root, `credentials.${randomUUID()}.tmp`);
        try {
          writeFileSync(temp, JSON.stringify(config), { mode: 0o600, flag: "wx" });
          renameSync(temp, join(root, "credentials.json"));
        } finally {
          rmSync(temp, { force: true });
        }
        return { configured: true, baseUrl: config.baseUrl };
      } catch {
        // Never forward filesystem, validation or upstream details with credentials.
        throw new Error("Не удалось проверить и сохранить ключ Врата AI на этой машине. Повторите попытку.");
      }
    },
    deleteCredentials: (_input, context) => {
      try {
        context.signal.throwIfAborted();
        ++credentialMutation;
        rmSync(join(bridgeDataDir(context.experimental_paths.dataDir), "credentials.json"), { force: true });
        return { configured: false, baseUrl: DEFAULT_BASE_URL };
      } catch {
        throw new Error("Не удалось удалить ключ Врата AI на этой машине. Повторите попытку.");
      }
    },
    balance: (input, context) => {
      const config = readConfig(bridgeDataDir(context.experimental_paths.dataDir));
      return config ? fetchBalance(config.baseUrl, config.apiKey, context.signal, buildUserAgent(input?.client)) : { status: "unconfigured" as const };
    },
  },
});
